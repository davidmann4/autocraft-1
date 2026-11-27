// The worker API's EndpointSlice (src/build/worker-endpoint.ts): the leader writes its own address; a copy that no
// longer leads (a standby, or a leader whose epoch moved) leaves the slice alone; a slice that keeps naming another
// address fails the runner-leader health check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkerEndpointPublisher } from "../src/build/worker-endpoint.ts";
import { KubeError, type EndpointSliceApi, type KEndpointSlice } from "../src/build/kube-api.ts";
import { FencedError } from "../src/db/fence.ts";
import { leaderKey } from "../src/db/leader.ts";
import { computeChecks } from "../src/health-checks.ts";
import { writeSetting } from "../src/data/control/index.ts";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { connectDb } from "../src/db/open.ts";
import { SCRATCH } from "./scratch.ts";

class FakeSlices implements EndpointSliceApi {
  slice: KEndpointSlice = { metadata: { name: "worker", resourceVersion: "1" }, endpoints: [], ports: [{ name: "worker-api", port: 8981, protocol: "TCP" }] };
  patches = 0;
  forbidden = false;
  async getEndpointSlice() { return structuredClone(this.slice); }
  async patchEndpointSlice(_ns: string, _name: string, patch: object) {
    if (this.forbidden) throw new KubeError(403, "PATCH endpointslices: HTTP 403 forbidden");
    const p = patch as KEndpointSlice;
    if (p.metadata.resourceVersion && p.metadata.resourceVersion !== this.slice.metadata.resourceVersion) throw new KubeError(409, "conflict");
    this.patches++;
    this.slice = { ...this.slice, ...p, metadata: { name: "worker", resourceVersion: String(Number(this.slice.metadata.resourceVersion) + 1) } };
  }
}
const ips = (s: KEndpointSlice) => (s.endpoints ?? []).flatMap((e) => e.addresses);

test("the leader writes its address into the worker API's EndpointSlice; a copy that no longer leads leaves it alone", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "worker-endpoint-")), "t.db"));
  try {
    const kube = new FakeSlices();
    let leads = true;
    const guard = async () => { if (!leads) throw new FencedError("this process no longer leads the runner"); };
    const ep = { ns: "craft", name: "worker", ip: "10.0.0.5", pod: "runner-a", port: 8981 };
    const a = new WorkerEndpointPublisher(db, kube, ep, guard, () => {});
    const t0 = Date.parse("2026-11-22T12:00:00Z");
    await a.sync(t0);
    assert.deepEqual(ips(kube.slice), ["10.0.0.5"]);
    await a.sync(t0 + 10_000);
    assert.equal(kube.patches, 1, "a slice that already names the leader is not written again");

    // Another copy took over and wrote its own address; this one's epoch moved.
    kube.slice = { ...kube.slice, endpoints: [{ addresses: ["10.0.0.9"] }], metadata: { name: "worker", resourceVersion: "7" } };
    leads = false;
    await assert.rejects(a.sync(t0 + 20_000), FencedError);
    assert.deepEqual(ips(kube.slice), ["10.0.0.9"], "the new leader's address stays");

    // A leader that cannot write the slice: the runner-leader check fails once the grace is over.
    leads = true;
    kube.forbidden = true;
    const b = new WorkerEndpointPublisher(db, kube, { ...ep, ip: "10.0.0.6", pod: "runner-b" }, guard, () => {});
    const leaderAt = (ms: number) => writeSetting(db, leaderKey("runner"), JSON.stringify({ holder: "b", epoch: 2, since: new Date(t0).toISOString(), at: new Date(ms).toISOString(), replicas: 2, conn: {} }));
    const runnerLeader = async (ms: number) => (await computeChecks(db, ms)).find((c) => c.id === "runner-leader")?.state;
    await b.sync(t0 + 30_000);
    await leaderAt(t0 + 30_000);
    assert.equal(await runnerLeader(t0 + 30_000), "ok", "within the grace the leader may still write it");
    await b.sync(t0 + 90_000);
    await leaderAt(t0 + 90_000);
    assert.equal(await runnerLeader(t0 + 90_000), "fail");
    kube.forbidden = false;
    await b.sync(t0 + 100_000);
    assert.deepEqual(ips(kube.slice), ["10.0.0.6"]);
    assert.equal(await runnerLeader(t0 + 100_000), "ok");
  } finally {
    await db.close();
  }
});
