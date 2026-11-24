// Kubernetes build environments with a fake API: a queued task goes through its task, source, step and upload pods, the
// runner reads the results from pod status, and the pod key can read the task but never report a result; a task whose
// pod disappears or whose node is lost is requeued once, then failed; a claim that cannot start goes back to the queue;
// a stage's pod that cannot be created is retried; with a compile cache, only offline build steps read it, as CI would; a warm
// producer's pod gets the cache's write credentials and the signing key only where it needs them, and only it takes warm builds;
// a running step's output reaches the task log while it runs, each line once across a runner restart.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { decodeManifest, encodeManifest, makeHeader } from "../src/warm/manifest.ts";
import { authenticate, createEnv, kubeReport } from "../src/build/envs.ts";
import type { CapacityApi, ExecResult, KNode, KPod, KResourceQuota, KubeApi } from "../src/build/kube-api.ts";
import { launcherPass, LauncherState } from "../src/build/launcher.ts";
import { DEFAULT_SETTINGS, groupsOf, kubeCapabilities, parseSettings, quantity, stepPod, type Prepared } from "../src/build/pods.ts";
import { claim, createTask, getTask } from "../src/build/tasks.ts";
import { queueWarm, WARM_PRODUCER_REV } from "../src/build/warm-queue.ts";
import { createWorkspace } from "../src/build/workspaces.ts";
import { warmPlan } from "../src/worker/rust.ts";
import { startWorkerServer } from "../src/build/worker-api.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "../src/db/open.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "build-pods-"));
process.env.AUTOCRAFT_ARTIFACT_DIR = join(dir, "artifacts");
const db = await connectDb(join(dir, "pods.db"));
await db.script("INSERT INTO tracked_repos (name, pipeline) VALUES ('open-app', 1); INSERT INTO repos (name, visibility) VALUES ('open-app', 'public')");
after(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

type Pod = Omit<KPod, "spec"> & { spec: Record<string, any> };
const matches = (labels: Record<string, string> | undefined, selector: string) => selector.split(",").every((kv) => labels?.[kv.split("=")[0]!] === kv.split("=")[1]);

class FakeKube implements KubeApi, CapacityApi {
  pods = new Map<string, Pod>();
  pvcs = new Map<string, { metadata: { name: string; labels?: Record<string, string> } }>();
  /** Makes the next creates that match throw, as a rate limit or quota would. */
  refuse: ((kind: "pod" | "pvc", labels: Record<string, string>) => boolean) | null = null;
  #refused(kind: "pod" | "pvc", o: object) {
    if (this.refuse?.(kind, (o as { metadata: { labels: Record<string, string> } }).metadata.labels)) throw new Error("HTTP 429 too many requests");
  }
  async listPods(_ns: string, sel: string) { return [...this.pods.values()].filter((p) => matches(p.metadata.labels, sel)); }
  async createPod(ns: string, pod: object) {
    this.#refused("pod", pod);
    const p = structuredClone(pod) as Pod;
    assert.equal((p.metadata as { namespace?: string }).namespace, ns);
    this.pods.set(p.metadata.name, { ...p, status: { phase: "Pending" } });
  }
  async deletePod(_ns: string, name: string) { this.pods.delete(name); }
  /** A container's output as the kubelet keeps it, one stamped line each ("<RFC 3339 time> <text>\n"); others say hello. */
  logs = new Map<string, string>();
  logReads: { container: string; limitBytes: number; sinceTime?: string }[] = [];
  async podLog(_ns: string, name: string, container: string, limitBytes: number, opts?: { sinceTime?: string; timestamps?: boolean }) {
    const raw = this.logs.get(`${name}/${container}`);
    if (raw === undefined) return `${container} of ${name} says hello\n`;
    this.logReads.push({ container, limitBytes, ...(opts?.sinceTime ? { sinceTime: opts.sinceTime } : {}) });
    const since = opts?.sinceTime ? Date.parse(opts.sinceTime) : -Infinity;
    const lines = raw.split(/(?<=\n)/).filter((l) => Date.parse(l.slice(0, l.indexOf(" "))) >= since).map((l) => opts?.timestamps ? l : l.slice(l.indexOf(" ") + 1));
    return Buffer.from(lines.join("")).subarray(0, limitBytes).toString("utf8");
  }
  async listPvcs(_ns: string, sel: string) { return [...this.pvcs.values()].filter((v) => matches(v.metadata.labels, sel)); }
  async createPvc(_ns: string, pvc: object) { this.#refused("pvc", pvc); const v = structuredClone(pvc) as { metadata: { name: string } }; this.pvcs.set(v.metadata.name, v); }
  async deletePvc(_ns: string, name: string) { this.pvcs.delete(name); }
  async getNode() { return null; }
  /** What the capacity reads return; `forbidden` makes the cluster-wide reads throw as a 403 would. */
  nodes: object[] = [];
  clusterPods: object[] = [];
  quotas: object[] = [];
  forbidden = false;
  async listNodes() { if (this.forbidden) throw new Error("HTTP 403"); return structuredClone(this.nodes) as KNode[]; }
  async listClusterPods() { if (this.forbidden) throw new Error("HTTP 403"); return structuredClone(this.clusterPods) as KPod[]; }
  async getQuota() { if (this.forbidden) throw new Error("HTTP 403"); return structuredClone(this.quotas) as KResourceQuota[]; }
  async canI() { return true; }
  /** What the next execs return, and the argv of each call. */
  execResult: ExecResult = { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false };
  execs: string[][] = [];
  async exec(_ns: string, _pod: string, _container: string, argv: string[]) { this.execs.push(argv); return { ...this.execResult }; }
  /** The single pod of a task, or fails. */
  only(task: number): Pod {
    const p = [...this.pods.values()].filter((x) => x.metadata.labels?.["craft.build/task"] === String(task));
    assert.equal(p.length, 1, `one pod for task ${task}`);
    return p[0]!;
  }
  /** Ends every container of a pod with the given exit codes (0 when not named). */
  end(pod: Pod, codes: Record<string, { exitCode: number; message?: string }> = {}) {
    const st = (c: { name: string }) => ({ name: c.name, state: { terminated: { startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:03Z", ...(codes[c.name] ?? { exitCode: 0 }) } } });
    const init = (pod.spec.initContainers ?? []) as { name: string }[], main = pod.spec.containers as { name: string }[];
    const failed = [...init, ...main].some((c) => (codes[c.name]?.exitCode ?? 0) !== 0);
    pod.status = { phase: failed ? "Failed" : "Succeeded", initContainerStatuses: init.map(st), containerStatuses: main.map(st) };
  }
}

const envOf = (c: { env?: { name: string; value: string }[] }) => Object.fromEntries((c.env ?? []).map((e) => [e.name, e.value]));
const SHA = "b".repeat(40);
let clock = Date.now();
const kube = new FakeKube();
const state = new LauncherState();
const pass = () => launcherPass({ db, api: kube, defaultImage: null, log: () => {}, now: () => clock }, state);

await createEnv(db, { id: "pods", label: "Pods", kind: "kubernetes", slots: 2, settings: { image: "autocraft:test", toolchainImages: { "rust-stable": "rust-stable:test" } } }, "op");

test("a task runs through its pods and its results come from pod status", async () => {
  const id = await createTask(db, {
    step: "verify", repo: "open-app", headSha: SHA, requires: { os: "linux", toolchains: ["rust-stable"] },
    plan: [
      { name: "fetch deps", cmd: ["cargo", "fetch"], network: "fetch", timeoutSec: 600 },
      { name: "build", cmd: ["cargo", "build"], network: "none", timeoutSec: 600 },
      { name: "test", cmd: ["cargo", "test"], network: "none", timeoutSec: 600, artifacts: ["report.json"] },
    ],
  });
  await pass();
  assert.equal((await getTask(db, id))!.state, "running");
  assert.equal(kube.pvcs.size, 1);
  const taskPod = kube.only(id);
  const spec = taskPod.spec;
  assert.equal(taskPod.metadata.labels!["craft.build/network"], "api");
  assert.equal(spec.automountServiceAccountToken, false);
  assert.equal(spec.restartPolicy, "Never");
  assert.deepEqual(spec.nodeSelector, { "kubernetes.io/arch": "amd64" });
  assert.equal(spec.tolerations, undefined);
  assert.equal(spec.securityContext.runAsNonRoot, true);
  assert.ok(spec.activeDeadlineSeconds > 0);
  assert.ok(spec.volumes.every((v: Record<string, unknown>) => v.persistentVolumeClaim || v.emptyDir), "only the task's volume and emptyDirs");
  const c = spec.containers[0];
  assert.equal(c.image, "autocraft:test");
  assert.ok(c.resources.limits.cpu && c.resources.limits.memory && c.resources.limits["ephemeral-storage"]);
  const key = envOf(c).AUTOCRAFT_POD_KEY!;
  assert.equal((await authenticate(db, key))?.taskId, id);

  // The key reads its task and nothing else: no result, no claim, no other task.
  const w = await startWorkerServer({ db, listen: "127.0.0.1:0" });
  try {
    const call = (method: string, path: string, body?: object) =>
      fetch(`${w.url}${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const got = await call("GET", "/worker/pod/task");
    assert.equal(got.status, 200);
    assert.equal(((await got.json()) as { steps: unknown[] }).steps.length, 3);
    assert.equal((await call("POST", `/worker/tasks/${id}/finish`, { results: [{ step: "build", exitCode: 0, durationMs: 1, timedOut: false }], summary: "ok" })).status, 403);
    assert.equal((await call("POST", "/worker/claim", { free: 1 })).status, 403);
  } finally {
    await w.close();
  }

  kube.end(taskPod);
  await pass();
  assert.equal(await authenticate(db, key), null, "the task pod's key dies before repository code runs");
  const source = kube.only(id);
  assert.equal(source.metadata.labels!["craft.build/network"], "fetch");
  assert.equal(envOf(source.spec.containers[0]).AUTOCRAFT_POD_KEY, undefined);

  kube.end(source, { source: { exitCode: 0, message: JSON.stringify({ ok: true, env: { GATE_FLAG: "1" }, mounts: [], packages: [], craftFontsRef: null, craftI18nRev: null }) } });
  await pass();
  const fetchPod = kube.only(id);
  assert.equal(fetchPod.metadata.labels!["craft.build/network"], "fetch");
  assert.deepEqual(fetchPod.spec.initContainers.map((x: { name: string; image: string }) => [x.name, x.image]), [["disk", "autocraft:test"]], "the volume is measured by trusted code first");
  assert.deepEqual(fetchPod.spec.containers.map((x: { name: string }) => x.name), ["step-0"]);
  assert.equal(fetchPod.spec.containers[0].image, "rust-stable:test");
  assert.equal(envOf(fetchPod.spec.containers[0]).GATE_FLAG, undefined, "a fetch step gets no gate env");

  kube.end(fetchPod);
  await pass();
  const offline = kube.only(id);
  assert.equal(offline.metadata.labels!["craft.build/network"], "none");
  assert.deepEqual(offline.spec.initContainers.map((x: { name: string }) => x.name), ["disk", "step-1"]);
  assert.deepEqual(offline.spec.containers.map((x: { name: string }) => x.name), ["step-2"]);
  assert.equal(envOf(offline.spec.containers[0]).GATE_FLAG, "1");

  kube.end(offline);
  await pass();
  const upload = kube.only(id);
  assert.equal(upload.metadata.labels!["craft.build/network"], "api");
  assert.ok(await authenticate(db, envOf(upload.spec.containers[0]).AUTOCRAFT_POD_KEY!));

  kube.end(upload);
  await pass();
  const t = (await getTask(db, id))!;
  assert.equal(t.state, "done");
  assert.deepEqual(t.results.map((r) => [r.step, r.exitCode]), [["fetch deps", 0], ["build", 0], ["test", 0]]);
  assert.equal(kube.pods.size, 0);
  assert.equal(kube.pvcs.size, 0);
  assert.equal(await authenticate(db, envOf(upload.spec.containers[0]).AUTOCRAFT_POD_KEY!), null);
});

test("a failing step ends the task without running later pods", async () => {
  const id = await createTask(db, {
    step: "verify", repo: "open-app", headSha: SHA, requires: { os: "linux", toolchains: ["rust-stable"] },
    plan: [
      { name: "build", cmd: ["cargo", "build"], network: "none", timeoutSec: 600 },
      { name: "fetch more", cmd: ["cargo", "fetch"], network: "fetch", timeoutSec: 600 },
    ],
  });
  await pass();
  kube.end(kube.only(id));
  await pass();
  kube.end(kube.only(id), { source: { exitCode: 0, message: JSON.stringify({ ok: true, env: {}, mounts: [], packages: [], craftFontsRef: null, craftI18nRev: null }) } });
  await pass();
  kube.end(kube.only(id), { "step-0": { exitCode: 101 } });
  await pass();
  const t = (await getTask(db, id))!;
  assert.equal(t.state, "failed");
  assert.match(t.summary ?? "", /build failed \(exit 101\)/);
  assert.equal(kube.pods.size, 0);
});

test("a task whose pod disappears is requeued once, then failed", async () => {
  const id = await createTask(db, { step: "verify", repo: "open-app", headSha: SHA, requires: { os: "linux", toolchains: ["rust-stable"] }, plan: [{ name: "t", cmd: ["true"], network: "none", timeoutSec: 60 }] });
  await pass();
  kube.pods.delete(kube.only(id).metadata.name);
  clock += 60_000;
  await pass();
  // Requeued, and claimed again in the same pass.
  assert.equal((await db.get(db.k.selectFrom("build_tasks").select("attempts").where("id", "=", id)))!.attempts, 2);
  kube.pods.delete(kube.only(id).metadata.name);
  clock += 60_000;
  await pass();
  const t = (await getTask(db, id))!;
  assert.equal(t.state, "failed");
  assert.match(t.summary ?? "", /disappeared/);
  assert.equal(kube.pods.size, 0);
  assert.equal(kube.pvcs.size, 0);
});

const queued = async (id: number) => (await db.get(db.k.selectFrom("build_tasks").select(["state", "attempts"]).where("id", "=", id)))!;
const runOf = async (id: number) => await db.get(db.k.selectFrom("build_pod_runs").select(["stage", "pod"]).where("task_id", "=", id));
const simple = async () => await createTask(db, { step: "verify", repo: "open-app", headSha: SHA, requires: { os: "linux", toolchains: ["rust-stable"] }, plan: [{ name: "t", cmd: ["true"], network: "none", timeoutSec: 60 }] });
const SOURCE_OK = JSON.stringify({ ok: true, env: {}, mounts: [], packages: [], craftFontsRef: null, craftI18nRev: null });

test("claims that cannot start go back to the queue without using an attempt", async () => {
  const a = await simple(), b = await simple();
  kube.refuse = (kind) => kind === "pvc";
  await pass();
  kube.refuse = null;
  for (const id of [a, b]) assert.deepEqual({ ...await queued(id) }, { state: "queued", attempts: 0 });
  assert.equal(await runOf(a) ?? await runOf(b), undefined);
  clock += 61_000;
  await pass();
  assert.equal((await queued(a)).state, "running");
  assert.equal((await queued(b)).state, "running");
  await db.run(db.k.updateTable("build_tasks").set({ state: "cancelled" }).where("id", "in", [a, b]));
  await pass();
  assert.equal(kube.pods.size, 0);
});

test("a stage's pod that cannot be created is retried, not given up at once", async () => {
  const id = await simple();
  await pass();
  kube.end(kube.only(id));
  kube.refuse = (kind, labels) => kind === "pod" && labels["craft.build/stage"] === "1";
  await pass();
  kube.refuse = null;
  assert.equal((await queued(id)).state, "running");
  assert.deepEqual({ ...await runOf(id) }, { stage: 1, pod: null });
  await pass();
  assert.equal(kube.pods.size, 0, "waits for the backoff");
  clock += 20_000;
  await pass();
  assert.equal(kube.only(id).metadata.labels!["craft.build/stage"], "1");
  kube.end(kube.only(id), { source: { exitCode: 0, message: SOURCE_OK } });
  await pass();
  kube.end(kube.only(id));
  await pass();
  assert.equal((await queued(id)).state, "done");
});

test("a pod on a lost node loses its task", async () => {
  const id = await simple();
  await pass();
  const first = kube.only(id);
  first.status = { phase: "Running" };
  first.metadata.deletionTimestamp = new Date(clock - 6 * 60_000).toISOString();
  await pass();
  assert.equal((await queued(id)).attempts, 2, "requeued and claimed again");
  const second = kube.only(id);
  assert.notEqual(second.metadata.name, first.metadata.name);
  second.status = { phase: "Unknown" };
  await pass();
  assert.equal((await queued(id)).state, "running");
  clock += 6 * 60_000;
  await pass();
  const t = (await getTask(db, id))!;
  assert.equal(t.state, "failed");
  assert.match(t.summary ?? "", /stopped reporting/);
  assert.equal(kube.pods.size, 0);
});

const capacityPass = () => launcherPass({ db, api: kube, capacity: kube, defaultImage: null, log: () => {}, now: () => clock }, state);
const node = (name: string, cpu: string) => ({ metadata: { name, labels: { "kubernetes.io/arch": "amd64" } }, status: { conditions: [{ type: "Ready", status: "True" }], allocatable: { cpu, memory: "64Gi" } } });
const UNSCHEDULABLE = { phase: "Pending" as const, conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/1 nodes are available: 1 Insufficient cpu." }] };

test("under cluster capacity, claims stop at the first task that does not fit and while one of our pods is unschedulable", async () => {
  kube.nodes = [node("node-a", "6")];
  const a = await simple(), b = await simple();
  await capacityPass();
  assert.equal((await queued(a)).state, "running");
  assert.equal((await queued(b)).state, "queued", "the node has no room left for a second step pod");
  const first = kube.only(a);
  assert.deepEqual(first.spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].values, ["node-a"]);
  const slots = async () => (await db.get(db.k.selectFrom("build_envs").select("reported_slots").where("id", "=", "pods")))!.reported_slots;
  assert.equal(await slots(), 1);

  kube.nodes = [node("node-a", "64")];
  first.status = structuredClone(UNSCHEDULABLE);
  await capacityPass();
  assert.equal((await queued(b)).state, "queued", "the scheduler found no room for our pod: nothing new is claimed");
  first.status = { phase: "Running" };
  await capacityPass();
  assert.equal((await queued(b)).state, "running");
  assert.equal(await slots(), 2, "with room to spare the environment offers its slots, the ceiling");

  await db.run(db.k.updateTable("build_tasks").set({ state: "cancelled" }).where("id", "in", [a, b]));
  await capacityPass();
  assert.equal(kube.pods.size, 0);
  kube.nodes = [];
});

test("a preempted step pod runs again on the same volume without using an attempt", async () => {
  const id = await simple();
  await pass();
  kube.end(kube.only(id));
  await pass();
  kube.end(kube.only(id), { source: { exitCode: 0, message: SOURCE_OK } });
  await pass();
  const step = kube.only(id);
  step.status = {
    phase: "Failed", conditions: [{ type: "DisruptionTarget", status: "True", reason: "PreemptionByScheduler", message: "preempted by a higher priority pod" }],
    initContainerStatuses: [{ name: "step-0", state: { terminated: { exitCode: 137, reason: "Error" } } }],
  };
  await pass();
  const again = kube.only(id);
  assert.notEqual(again.metadata.name, step.metadata.name);
  assert.equal(again.metadata.labels!["craft.build/stage"], step.metadata.labels!["craft.build/stage"]);
  assert.deepEqual(again.spec.volumes[0], step.spec.volumes[0], "the same volume");
  assert.deepEqual({ ...await queued(id) }, { state: "running", attempts: 1 });
  kube.end(again);
  await pass();
  assert.equal((await queued(id)).state, "done");
});

test("a task pod recreated after a disruption stays on its volume's node; an eviction for the pod's own size limit is the step's failure", async () => {
  const id = await simple();
  await pass();
  const first = kube.only(id);
  first.status = { phase: "Failed", conditions: [{ type: "DisruptionTarget", status: "True", reason: "TerminationByKubelet" }] };
  await pass();
  const again = kube.only(id);
  assert.notEqual(again.metadata.name, first.metadata.name);
  again.status = structuredClone(UNSCHEDULABLE);
  clock += 20 * 60_000;
  await pass();
  assert.equal(kube.only(id).metadata.name, again.metadata.name, "its volume is bound: it waits for room instead of moving");
  assert.equal((await queued(id)).state, "running");
  kube.end(again);
  await pass();
  kube.end(kube.only(id), { source: { exitCode: 0, message: SOURCE_OK } });
  await pass();
  const step = kube.only(id);
  step.status = {
    phase: "Failed", reason: "Evicted", message: "Usage of EmptyDir volume \"tmp\" exceeds the limit \"16Gi\".",
    initContainerStatuses: [{ name: "step-0", state: { terminated: { exitCode: 137, reason: "Error" } } }],
  };
  await pass();
  const t = (await getTask(db, id))!;
  assert.equal(t.state, "failed");
  assert.equal((await queued(id)).attempts, 1);
  assert.match(t.summary ?? "", /exceeds the limit/);
});

test("with a compile cache, offline build steps read it at the CI runners' paths; fetch and bare steps never reach it", () => {
  const s = { ...DEFAULT_SETTINGS, sccacheUrl: "http://cache.test:8080" };
  const plan = [
    { name: "fetch deps", cmd: ["cargo", "fetch"], network: "fetch" as const, timeoutSec: 600 },
    { name: "build", cmd: ["cargo", "build"], network: "none" as const, timeoutSec: 600 },
    { name: "format", cmd: ["cargo", "fmt"], network: "none" as const, timeoutSec: 600, bare: true },
  ];
  const gate: Prepared = { env: { CARGO_PROFILE_DEV_DEBUG: "0" }, mounts: [], packages: [], craftFontsRef: null, craftI18nRev: null, cacheVersion: "v2" };
  const [fetchGroup, offlineGroup] = groupsOf(plan);
  const podOf = (group: typeof fetchGroup, prepared: Prepared) =>
    stepPod({ s, envId: "pods", taskId: 1, stage: 2, name: "p", pvc: "v", deadlineSec: 600 }, "rust-stable:test", "autocraft:test", plan, group!, prepared, false, "open-app") as unknown as Pod;
  const steps = (p: Pod): Record<string, any> => Object.fromEntries([...p.spec.initContainers, ...p.spec.containers].map((c: { name: string }) => [c.name, c]));

  assert.equal(podOf(fetchGroup, gate).metadata.labels!["craft.build/cache"], undefined);
  assert.equal(envOf(steps(podOf(fetchGroup, gate))["step-0"]).RUSTC_WRAPPER, undefined);

  const offline = podOf(offlineGroup, gate);
  assert.equal(offline.metadata.labels!["craft.build/cache"], "read");
  const build = steps(offline)["step-1"], env = envOf(build);
  assert.equal(env.SCCACHE_WEBDAV_RW_MODE, "READ_ONLY");
  assert.equal(env.CARGO_PROFILE_DEV_DEBUG, "0", "the gate's env reaches the cached step");
  assert.equal(env.CARGO_TARGET_DIR, undefined, "sccache keys on CARGO_* variables, and CI sets no target dir");
  assert.ok(build.workingDir.startsWith("/home/runner/_work/"), "the step works where CI checks the repo out");
  const target = build.volumeMounts.find((m: { subPath?: string }) => m.subPath === "target");
  assert.equal(target.mountPath, `${build.workingDir}/target`, "the build output is the checkout's default target dir");
  assert.equal(envOf(steps(offline)["step-2"]).SCCACHE_WEBDAV_ENDPOINT, undefined, "a bare step has no build dirs and no cache");

  assert.equal(podOf(offlineGroup, { ...gate, cacheVersion: null }).metadata.labels!["craft.build/cache"], undefined, "no CI gate, no cache");
});

test("a fetch pod before a warm offline pod copies only CARGO_HOME first; only that copy mounts the node's warm dir", () => {
  const plan = [
    { name: "fetch deps", cmd: ["cargo", "fetch"], network: "fetch" as const, timeoutSec: 600 },
    { name: "build", cmd: ["cargo", "build"], network: "none" as const, timeoutSec: 600 },
  ];
  const gate: Prepared = { env: {}, mounts: [], packages: [], craftFontsRef: null, craftI18nRev: null, cacheVersion: "v2" };
  const [fetchGroup] = groupsOf(plan);
  const ctx = { s: DEFAULT_SETTINGS, envId: "pods", taskId: 1, stage: 2, name: "p", pvc: "v", deadlineSec: 600 };
  const use = { target: "pvc" as const, node: "node-1", key: "open-app-0123", commit: SHA, bytes: 1e9, sameLock: true };
  const podOf = (u?: typeof use) => stepPod(ctx, "rust-stable:test", "autocraft:test", plan, fetchGroup!, gate, false, "open-app", undefined, u) as unknown as Pod;
  const all = (p: Pod): Record<string, any>[] => [...(p.spec.initContainers ?? []), ...p.spec.containers];
  const seeded = podOf(use), plain = podOf();
  const warmMounts = all(seeded).filter((c) => (c.volumeMounts ?? []).some((m: { name: string }) => m.name === "warm-node")).map((c) => c.name);
  assert.deepEqual(warmMounts, ["warm-copy"]);
  const copy = all(seeded).find((c) => c.name === "warm-copy")!;
  assert.equal(envOf(copy).AUTOCRAFT_WARM_PART, "cargo");
  assert.equal(envOf(copy).AUTOCRAFT_WARM_SAME_LOCK, undefined, "the fetch adds what another Cargo.lock needs");
  assert.ok(!copy.volumeMounts.some((m: { mountPath: string }) => m.mountPath.endsWith("/target")), "the copy before the fetch has no target");
  const step = (p: Pod) => all(p).find((c) => c.name === "step-0")!;
  assert.deepEqual(step(seeded).env, step(plain).env);
  assert.deepEqual(step(seeded).volumeMounts, step(plain).volumeMounts);
  assert.equal(seeded.metadata.labels!["craft.build/network"], "fetch");
});

const WARM = parseSettings({
  namespace: "craft-warm", image: "autocraft:test", toolchainImages: { "rust-stable": "rust-stable:test" }, warmWriter: true, crateMirror: "10.43.250.25",
  sccacheUrl: "http://cache.test:8080", cacheWriteUrl: "http://cache.test:8081", writerSecret: "writer", signingSecret: "signing",
});

test("a warm producer's pods: the mirror for the fetch, then restore, build with cache writes and publish, each with only the secrets it needs", () => {
  const plan = warmPlan({ mirror: true });
  const gate: Prepared = { env: {}, mounts: [], packages: [], craftFontsRef: null, craftI18nRev: null, cacheVersion: "v2", warmCommand: "cargo test --workspace --no-run --locked" };
  const [fetchGroup, buildGroup] = groupsOf(plan);
  const ctx = { s: WARM, envId: "warm", taskId: 1, stage: 2, name: "p", pvc: "v", deadlineSec: 600 };
  const all = (p: Pod): Record<string, any>[] => [...(p.spec.initContainers ?? []), ...p.spec.containers];
  const secretsOf = (c: Record<string, any>) => (c.env ?? []).filter((e: { valueFrom?: unknown }) => e.valueFrom).map((e: { valueFrom: { secretKeyRef: { name: string } } }) => e.valueFrom.secretKeyRef.name);
  const mounts = (c: Record<string, any>) => (c.volumeMounts as { name: string; mountPath: string }[]);

  const fetchPod = stepPod(ctx, "rust-stable:test", "autocraft:test", plan, fetchGroup!, gate, true, "open-app", { key: "k", gc: false }) as unknown as Pod;
  assert.equal(fetchPod.metadata.labels!["craft.build/network"], "mirror");
  assert.equal(fetchPod.metadata.labels!["craft.build/cache"], undefined, "the fetch pod writes no cache");
  assert.deepEqual(fetchPod.spec.hostAliases, [{ ip: "10.43.250.25", hostnames: ["index.crates.io", "static.crates.io", "github.com", "api.github.com"] }]);
  const fetchStep = fetchPod.spec.containers[0];
  assert.equal(envOf(fetchStep).CARGO_HTTP_CAINFO, "/etc/craft-mirror/ca.crt");
  assert.ok(mounts(fetchStep).some((m) => m.mountPath === "/etc/craft-mirror"));
  assert.ok(all(fetchPod).every((c) => !secretsOf(c).length), "no credentials while dependencies are fetched");

  const build = stepPod(ctx, "rust-stable:test", "autocraft:test", plan, buildGroup!, gate, false, "open-app", { key: "k", gc: true, bytes: 2 * 1024 ** 3 }) as unknown as Pod;
  assert.equal(build.metadata.labels!["craft.build/network"], "none");
  assert.equal(build.metadata.labels!["craft.build/cache"], "write");
  const names = all(build).map((c) => c.name);
  assert.ok(names.indexOf("warm-restore") < names.indexOf("step-1") && names.indexOf("step-1") < names.indexOf("warm-publish"), "restore, build, publish in that order");
  assert.equal(names.at(-1), "warm-gc");
  const byName = Object.fromEntries(all(build).map((c) => [c.name, c]));
  for (const c of all(build)) {
    assert.deepEqual(secretsOf(c).length > 0, ["step-1", "warm-publish", "warm-gc"].includes(c.name), `writer credentials on ${c.name}`);
    assert.equal(mounts(c).some((m) => m.name === "warm-signing"), c.name === "warm-publish", `private signing key on ${c.name}`);
    assert.equal(mounts(c).some((m) => m.name === "warm-verify"), ["warm-restore", "warm-gc"].includes(c.name), `public key on ${c.name}`);
  }
  const step = byName["step-1"]!, env = envOf(step);
  assert.equal(env.SCCACHE_WEBDAV_ENDPOINT, "http://cache.test:8081");
  assert.equal(env.SCCACHE_WEBDAV_RW_MODE, undefined);
  assert.equal(env.AUTOCRAFT_WARM_COMMAND, gate.warmCommand);
  const target = `${step.workingDir}/target`;
  for (const c of [step, byName["warm-restore"]!, byName["warm-publish"]!]) assert.ok(mounts(c).some((m) => m.name === "warm-target" && m.mountPath === target), `${c.name} sees the build's target dir`);
  assert.equal(build.spec.volumes.find((v: { name: string }) => v.name === "warm-target").emptyDir.medium, "Memory");
  assert.equal(envOf(byName["warm-publish"]!).AUTOCRAFT_WARM_TARGET, target, "published at the path the build used");
  const slug = envOf(byName["warm-publish"]!).AUTOCRAFT_WARM_REPO!;
  assert.match(slug, /^[\w.-]+\/open-app$/, "the publish gets the repo as owner/name although the task stores the bare name");
  const header = makeHeader({ key: "a".repeat(8), repo: slug, commit: "c".repeat(40), stored: 1, image: null, rustc: null, envHash: null, checkout: null, targetDir: target, cargoHome: "/cache/cargo" }, []);
  assert.equal(decodeManifest(encodeManifest({ header, entries: [] })).header.repo, slug, "the header is accepted when written and when read back");
});

test("a warm producer's memory limit grows with the expected warm bytes; a large or unknown version puts the target on the volume", () => {
  const plan = warmPlan({ mirror: true });
  const gate: Prepared = { env: {}, mounts: [], packages: [], craftFontsRef: null, craftI18nRev: null, cacheVersion: "v2", warmCommand: null };
  const buildGroup = groupsOf(plan)[1]!;
  const ctx = { s: WARM, envId: "warm", taskId: 1, stage: 2, name: "p", pvc: "v", deadlineSec: 600 };
  const podOf = (bytes?: number) => stepPod(ctx, "rust-stable:test", "autocraft:test", plan, buildGroup, gate, false, "open-app", { key: "k", gc: false, ...(bytes !== undefined && { bytes }) }) as unknown as Pod;
  const memOf = (p: Pod) => Number((p.spec.containers.concat(p.spec.initContainers ?? []).find((c: Record<string, any>) => c.name === "step-1") as Record<string, any>).resources.limits.memory);
  const inMemory = (p: Pod) => p.spec.volumes.some((v: { name: string; emptyDir?: { medium?: string } }) => v.name === "warm-target" && v.emptyDir?.medium === "Memory");
  const GiB = 1024 ** 3;
  const small = podOf(2 * GiB), smaller = podOf(1 * GiB);
  assert.ok(inMemory(small));
  assert.ok(memOf(small) > memOf(smaller) && memOf(smaller) >= quantity(WARM.memoryLimit) + 1.2 * GiB, "the limit adds the warm bytes");
  for (const p of [podOf(), podOf(40 * GiB)]) {
    assert.ok(!inMemory(p), "no version known, or a large one: the target is on the volume");
    assert.equal(p.spec.containers.concat(p.spec.initContainers ?? []).find((c: Record<string, any>) => c.name === "step-1")!.resources.limits.memory, WARM.memoryLimit);
    assert.ok(!p.spec.volumes.some((v: { name: string }) => v.name === "warm-target"));
  }
});

test("a workspace is refused on a warm writer environment", async () => {
  const d = await connectDb(":memory:");
  await createEnv(d, { id: "warm", label: "Warm", kind: "kubernetes", slots: 1, settings: WARM }, "op");
  await assert.rejects(createWorkspace(d, { repo: "app", baseSha: "a".repeat(40), envId: "warm", owner: null }), /warm writer/);
});

test("a finished warm build blocks a new one only when it was queued under the current producer revision", async () => {
  const d = await connectDb(":memory:");
  await d.script("INSERT INTO tracked_repos (name, pipeline) VALUES ('app', 1); INSERT INTO repos (name, visibility) VALUES ('app', 'public')");
  const at = "2026-01-01T00:00:00Z";
  await d.run(d.k.insertInto("main_ci").values({
    repo: "app", head_sha: "a".repeat(40), branch: "main", state: "green", failing: "[]", checks: "[]", committed_at: at, headline: null, first_seen_at: at, state_changed_at: at, updated_at: at,
  }));
  const first = await queueWarm(d, "app", WARM);
  assert.ok(first);
  await d.run(d.k.updateTable("build_tasks").set({ state: "done" }).where("id", "=", first));
  assert.equal(await queueWarm(d, "app", WARM), null, "a done build of the current revision blocks");
  for (const rev of [null, WARM_PRODUCER_REV - 1]) {
    await d.run(d.k.updateTable("build_tasks").set({ warm_rev: rev }).where("id", "=", first));
    const again = await queueWarm(d, "app", WARM);
    assert.ok(again, `a done build of revision ${rev} does not block`);
    await d.run(d.k.updateTable("build_tasks").set({ state: "cancelled" }).where("id", "=", again));
  }
  await d.run(d.k.updateTable("build_tasks").set({ warm_rev: WARM_PRODUCER_REV }).where("id", "=", first));
  assert.ok(await queueWarm(d, "app", WARM, true), "a forced rebuild queues anyway");
});

test("a failed warm build is retried under a new AutoCraft version, once per version", async () => {
  const d = await connectDb(":memory:");
  await d.script("INSERT INTO tracked_repos (name, pipeline) VALUES ('app', 1); INSERT INTO repos (name, visibility) VALUES ('app', 'public')");
  const at = "2026-01-01T00:00:00Z";
  await d.run(d.k.insertInto("main_ci").values({
    repo: "app", head_sha: "a".repeat(40), branch: "main", state: "green", failing: "[]", checks: "[]", committed_at: at, headline: null, first_seen_at: at, state_changed_at: at, updated_at: at,
  }));
  const saved = process.env.AUTOCRAFT_IMAGE;
  try {
    process.env.AUTOCRAFT_IMAGE = "autocraft@sha256:old";
    const first = await queueWarm(d, "app", WARM);
    assert.ok(first);
    await d.run(d.k.updateTable("build_tasks").set({ state: "failed" }).where("id", "=", first));
    assert.equal(await queueWarm(d, "app", WARM), null, "the same version does not retry its own failure");
    process.env.AUTOCRAFT_IMAGE = "autocraft@sha256:new";
    const second = await queueWarm(d, "app", WARM);
    assert.ok(second, "a new version retries");
    await d.run(d.k.updateTable("build_tasks").set({ state: "failed" }).where("id", "=", second));
    assert.equal(await queueWarm(d, "app", WARM), null, "one attempt per version");
    await d.run(d.k.updateTable("build_tasks").set({ state: "done" }).where("id", "=", second));
    process.env.AUTOCRAFT_IMAGE = "autocraft@sha256:newer";
    assert.equal(await queueWarm(d, "app", WARM), null, "a successful build blocks under any version");
  } finally {
    if (saved === undefined) delete process.env.AUTOCRAFT_IMAGE; else process.env.AUTOCRAFT_IMAGE = saved;
  }
});

test("a warm writer takes only warm builds, at the newest default-branch head; no other environment takes them", async () => {
  const d = await connectDb(":memory:");
  await d.script("INSERT INTO tracked_repos (name, pipeline) VALUES ('app', 1); INSERT INTO repos (name, visibility) VALUES ('app', 'public')");
  const pods = parseSettings({ toolchainImages: { "rust-stable": "rust-stable:test" } });
  await createEnv(d, { id: "pods", label: "Pods", kind: "kubernetes", slots: 4, settings: pods }, "op");
  await createEnv(d, { id: "warm", label: "Warm", kind: "kubernetes", slots: 4, settings: WARM }, "op");
  await kubeReport(d, "pods", kubeCapabilities(pods), 4, undefined, true);
  await kubeReport(d, "warm", kubeCapabilities(WARM), 4, undefined, true);
  const head = async (sha: string, at: string) => await d.run(d.k.insertInto("main_ci").values({
    repo: "app", head_sha: sha, branch: "main", state: "green", failing: "[]", checks: "[]", committed_at: at, headline: null, first_seen_at: at, state_changed_at: at, updated_at: at,
  }));
  await head("a".repeat(40), "2026-01-01T00:00:00Z");
  const pr = await createTask(d, { step: "verify", repo: "app", number: 1, headSha: "c".repeat(40), baseSha: "d".repeat(40), requires: { os: "linux", toolchains: ["rust-stable"] }, plan: warmPlan({ mirror: false }) });
  const warm = await queueWarm(d, "app", WARM);
  assert.ok(warm);
  assert.equal(await queueWarm(d, "app", WARM), null, "one queued warm build per repo");
  await head("e".repeat(40), "2026-01-01T01:00:00Z");

  const got = (await claim(d, "warm", 4)).tasks;
  assert.deepEqual(got.map((t) => t.id), [warm], "the warm writer takes no PR build");
  assert.equal(got[0]!.headSha, "e".repeat(40), "the warm build takes the newest head");
  assert.equal(got[0]!.plan[0]!.network, "mirror", "with a crate mirror the environment fetches through it");
  await d.run(d.k.updateTable("build_tasks").set({ state: "queued", env_id: null }).where("id", "=", warm));
  assert.deepEqual((await claim(d, "pods", 4)).tasks.map((t) => t.id), [pr], "a plain environment never takes a warm build");
  await d.close();
});

test("a running step's output reaches the task log while it runs, each line once across a runner restart and its end", async () => {
  const id = await simple();
  await pass();
  kube.end(kube.only(id));
  await pass();
  kube.end(kube.only(id), { source: { exitCode: 0, message: SOURCE_OK } });
  await pass();
  const pod = kube.only(id);
  const key = `${pod.metadata.name}/step-0`;
  const logOf = async () => (await db.all(db.k.selectFrom("build_task_logs").select(["step", "chunk"]).where("task_id", "=", id).orderBy("seq")))
    .filter((r) => r.step === "t").map((r) => r.chunk).join("");
  const running = () => {
    pod.status = { phase: "Pending", initContainerStatuses: [
      { name: "disk", state: { terminated: { exitCode: 0, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z" } } },
      { name: "step-0", state: { running: { startedAt: "2026-01-01T00:00:01Z" } } },
    ] };
  };
  running();
  // Lines that share a second, and two that share the exact time across a read's boundary.
  kube.logs.set(key, "2026-01-01T00:00:01.5Z one\n2026-01-01T00:00:02.000000001Z two\n2026-01-01T00:00:02.000000001Z three\n2026-01-01T00:00:02.9Z four (");
  await pass();
  assert.equal((await queued(id)).state, "running");
  assert.equal(await logOf(), "one\ntwo\nthree\n", "complete lines appear while the step runs");

  // The runner restarts: new launcher state, the same run row.
  kube.logs.set(key, `${kube.logs.get(key)}unfinished)\n2026-01-01T00:00:02.000000001Z five\n2026-01-01T00:00:03Z six\n`);
  await launcherPass({ db, api: kube, defaultImage: null, log: () => {}, now: () => clock }, new LauncherState());
  assert.equal(await logOf(), "one\ntwo\nthree\nfour (unfinished)\nfive\nsix\n");
  assert.ok(kube.logReads.at(-1)!.sinceTime, "a later read starts at a time, not from the start");

  kube.logs.set(key, `${kube.logs.get(key)}2026-01-01T00:00:03Z seven\n2026-01-01T00:00:04Z eight`);
  kube.end(pod);
  await launcherPass({ db, api: kube, defaultImage: null, log: () => {}, now: () => clock }, new LauncherState());
  assert.equal((await queued(id)).state, "done");
  assert.equal(await logOf(), "one\ntwo\nthree\nfour (unfinished)\nfive\nsix\nseven\neight", "each line once, the last one without its newline as written");
});
