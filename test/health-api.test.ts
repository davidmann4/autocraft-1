// GET /api/health: what it lists, and that nothing of a private repo or of the staff's texts reaches a viewer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { health } from "../src/dash/api/health.ts";
import type { Req } from "../src/dash/types.ts";
import { connectDb } from "./helpers/raw-db.ts";
import * as kx from "../src/db/kx.ts";

const req = (role: "operator" | "viewer"): Req => ({
  method: "GET", path: "", params: {}, query: new URLSearchParams(), form: new URLSearchParams(),
  user: { login: role, role, canWrite: async () => false, canRead: async () => false }, csrf: "", nonce: "",
} as unknown as Req);

test("health lists a failing sync, a tripped breaker and failed jobs, and hides a private repo and error texts from a viewer", async () => {
  const db = await connectDb(":memory:");
  const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
  await db.run(db.k.insertInto("repos").values([{ name: "photocraft", visibility: "public" }, { name: "secretcraft", visibility: "private" }]).onConflict((oc) => oc.column("name").doUpdateSet(kx.excluded(["visibility"]))));
  await db.run(db.k.insertInto("tracked_repos").values([{ name: "photocraft" }, { name: "secretcraft" }]).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.updateTable("tracked_repos").set({ pipeline: 1 }));
  for (const m of [30, 20, 10]) await db.run(db.k.insertInto("sync_runs").values({ started_at: at(m), ended_at: at(m - 1), mode: "full", items: 0, error: "HTTP 502 from GitHub" }));
  for (const repo of ["photocraft", "secretcraft"]) await db.run(db.k.insertInto("stage_trips").values({ stage: `fixup:${repo}`, reason: `pushes broke CI in ${repo}`, tripped_at: at(5), active: 1, evidence: "{}" }));
  for (const repo of ["photocraft", "secretcraft"]) await db.run(db.k.insertInto("jobs").values({ step: "opus-review", params: "{}", requested_by: "pipeline", requested_at: at(4), state: "failed", started_at: at(4), ended_at: at(2), error: "exit 1", repo }));

  const op = await health(db, req("operator"));
  const of = (h: typeof op, area: string) => h.problems.filter((p) => p.area === area);
  assert.match(of(op, "sync").map((p) => p.text).join("\n"), /HTTP 502/);
  assert.equal(of(op, "breaker").length, 2);
  assert.match(of(op, "jobs")[0]!.text, /2 jobs failed/);

  const viewer = await health(db, req("viewer"));
  assert.ok(!JSON.stringify(viewer).includes("secretcraft"), "nothing of the private repo");
  assert.ok(!JSON.stringify(viewer).includes("HTTP 502"), "no error text");
  assert.ok(of(viewer, "sync").length > 0 && of(viewer, "breaker").length === 1);
  assert.match(of(viewer, "jobs")[0]!.text, /1 job failed/);
});

test("an outside call made inside a transaction in the last hour warns staff only", async () => {
  const { note } = await import("../src/db/effects.ts");
  const db = await connectDb(":memory:");
  assert.ok(!(await health(db, req("operator"))).problems.some((p) => p.area === "database"));
  note("process", "a transaction", "test/health-api.test.ts:effect-site", false);
  assert.ok((await health(db, req("operator"))).problems.some((p) => p.area === "database"));
  assert.ok(!(await health(db, req("viewer"))).problems.some((p) => p.area === "database"));
});
