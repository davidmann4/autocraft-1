// Workspace pods with a fake Kubernetes API: a requested workspace gets its volume and pod, is seeded from AutoCraft's
// clone over exec stdin, parks after it sits idle (checkpoint stored, pod deleted, volume kept), and its parked volume
// goes after the keep time while the checkpoint stays. The build-task launcher leaves workspace pods alone. A background
// command keeps a workspace from parking; a parked one comes back for its bound call, on its volume or rebuilt from the
// base and the checkpoint.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { createEnv } from "../src/build/envs.ts";
import type { ExecOptions, ExecResult, KNode, KPod, KubeApi } from "../src/build/kube-api.ts";
import { launcherPass, LauncherState } from "../src/build/launcher.ts";
import { queueWorkspaceCall } from "../src/build/workspace-call.ts";
import { IDLE_PARK_MS, NODE_LOST_MS, PARKED_VOLUME_MS, RESUME_PENDING_MS, workspacePass, WorkspaceState } from "../src/build/workspace-launch.ts";
import { createWorkspace, getCheckpoint, getWorkspace, RESUME_TRIES, resumeWorkspace } from "../src/build/workspaces.ts";
import { WS_POD_PATH } from "../src/build/workspace.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "workspace-pods-"));
process.env.AUTOCRAFT_FIXUP_DIR = join(dir, "fixups");
const db = await connectDb(join(dir, "ws.db"));
await db.script("INSERT INTO tracked_repos (name, pipeline) VALUES ('open-app', 1); INSERT INTO repos (name, visibility) VALUES ('open-app', 'public')");
after(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

// AutoCraft's clone of the repo: a bare repository with one commit.
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
const src = join(dir, "src");
mkdirSync(src);
git(src, "init", "-q");
writeFileSync(join(src, "README.md"), "hello\n");
git(src, "add", "-A");
git(src, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "base");
const SHA = git(src, "rev-parse", "HEAD");
mkdirSync(join(dir, "fixups"));
git(dir, "clone", "-q", "--bare", src, join(dir, "fixups", "open-app"));

type Pod = Omit<KPod, "spec"> & { spec: Record<string, any> };
const matches = (labels: Record<string, string> | undefined, selector: string) => selector.split(",").every((kv) => labels?.[kv.split("=")[0]!] === kv.split("=")[1]);
const DIFF = Buffer.from("diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-hello\n+hello, workspace\n");
const POD_COMMIT = "c".repeat(40);

class FakeKube implements KubeApi {
  pods = new Map<string, Pod>();
  pvcs = new Map<string, { metadata: { name: string; labels?: Record<string, string> } }>();
  execs: string[][] = [];
  untarBytes = 0;
  /** Whether the volume still holds the tree (the resume check's answer). */
  kept = true;
  put: Buffer | null = null;
  /** The checkpoint's read fails. */
  checkpointFails = false;
  /** Nodes by name; a missing one is gone. */
  nodes = new Map<string, KNode>([["node-a", { metadata: { name: "node-a" }, status: { conditions: [{ type: "Ready", status: "True" }] } }]]);
  async getNode(name: string) { return this.nodes.get(name) ?? null; }
  async listPods(_ns: string, sel: string) { return [...this.pods.values()].filter((p) => matches(p.metadata.labels, sel)); }
  async createPod(_ns: string, pod: object) { const p = structuredClone(pod) as Pod; this.pods.set(p.metadata.name, { ...p, status: { phase: "Pending" } }); }
  async deletePod(_ns: string, name: string) { this.pods.delete(name); }
  async podLog() { return ""; }
  async listPvcs(_ns: string, sel: string) { return [...this.pvcs.values()].filter((v) => matches(v.metadata.labels, sel)); }
  async createPvc(_ns: string, pvc: object) { const v = structuredClone(pvc) as { metadata: { name: string } }; this.pvcs.set(v.metadata.name, v); }
  async deletePvc(_ns: string, name: string) { this.pvcs.delete(name); }
  async canI() { return true; }
  async exec(_ns: string, _pod: string, _container: string, argv: string[], opts: ExecOptions): Promise<ExecResult> {
    this.execs.push(argv);
    const ok = (stdout: Buffer | string): ExecResult => ({ exitCode: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), truncated: false });
    if (argv[0] === WS_POD_PATH && argv[1] === "untar") {
      const chunks: Buffer[] = [];
      const input = opts.stdin ?? Buffer.alloc(0);
      for await (const c of Buffer.isBuffer(input) ? [input] : input) chunks.push(c);
      const tar = Buffer.concat(chunks);
      this.untarBytes = tar.length;
      // A tar of the base commit: the ustar magic of its first header, and the file in it.
      assert.equal(tar.subarray(257, 262).toString(), "ustar");
      assert.ok(tar.includes(Buffer.from("hello\n")));
      return ok(`WS ok ${POD_COMMIT}\n`);
    }
    if (argv[0] === WS_POD_PATH && argv[1] === "run" && argv.includes("cat-file")) return ok(`WS exited ${this.kept ? 0 : 128} 15 0\n`);
    if (argv[0] === WS_POD_PATH && argv[1] === "run") return ok("WS exited 0 15 0\n");
    if (argv[0] === WS_POD_PATH && argv[1] === "put") {
      this.put = Buffer.isBuffer(opts.stdin) ? opts.stdin : null;
      return ok(`WS ok ${this.put?.length ?? 0} ${"d".repeat(64)}\n`);
    }
    if (argv[0] === "head") return this.checkpointFails ? { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("no"), truncated: false } : ok(DIFF);
    return { exitCode: 2, stdout: Buffer.from("WS error usage unknown\n"), stderr: Buffer.alloc(0), truncated: false };
  }
  /** The scheduler cannot place the pod. */
  unschedulable(name: string, message: string) {
    this.pods.get(name)!.status = { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message }] };
  }
  /** The pod runs and its container is ready, on node-a. */
  run(name: string) {
    const p = this.pods.get(name)!;
    p.spec.nodeName = "node-a";
    p.status = { phase: "Running", containerStatuses: (p.spec.containers as { name: string }[]).map((c) => ({ name: c.name, ready: true, state: { running: { startedAt: "2026-01-01T00:00:00Z" } } })) };
  }
}

let clock = Date.now();
const kube = new FakeKube();
const state = new WorkspaceState();
const deps = { db, api: kube, defaultImage: null, log: () => {}, now: () => clock };
const pass = async () => {
  await workspacePass(deps, state);
  await state.idle();
};

await createEnv(db, { id: "pods", label: "Pods", kind: "kubernetes", slots: 2, settings: { image: "autocraft:test", toolchainImages: { "rust-stable": "rust-stable:test" } } }, "op");

test("a workspace starts, is seeded, parks when idle and keeps its checkpoint after its volume goes", async () => {
  const id = await createWorkspace(db, { repo: "open-app", baseSha: SHA, envId: "pods", owner: "cli" }, clock);
  await pass();
  assert.equal((await getWorkspace(db, id))!.state, "starting");
  const pod = kube.pods.get(`ws-${id}`)!;
  assert.ok(pod && kube.pvcs.has(`ws-${id}`), "pod and volume created");
  const spec = pod.spec;
  assert.equal(pod.metadata.labels!["app.kubernetes.io/name"], "autocraft-workspace");
  assert.equal(pod.metadata.labels!["craft.build/network"], "none");
  assert.equal(spec.automountServiceAccountToken, false);
  assert.equal(spec.enableServiceLinks, false);
  assert.equal(spec.securityContext.runAsNonRoot, true);
  for (const c of [...spec.initContainers, ...spec.containers]) {
    assert.equal(c.securityContext.allowPrivilegeEscalation, false);
    assert.equal(c.securityContext.readOnlyRootFilesystem, true);
    assert.ok(c.resources.requests.cpu && c.resources.requests.memory, `${c.name} has requests (the namespace quota needs them)`);
  }
  assert.equal(spec.containers[0].image, "rust-stable:test");
  assert.ok(spec.initContainers[0].command.includes(WS_POD_PATH), "the helper is copied in");

  // The build-task launcher's sweep deletes only build pods.
  await launcherPass(deps, new LauncherState());
  assert.ok(kube.pods.has(`ws-${id}`) && kube.pvcs.has(`ws-${id}`), "the build launcher leaves workspace pods and volumes alone");

  kube.run(`ws-${id}`);
  await pass();
  let w = (await getWorkspace(db, id))!;
  assert.equal(w.state, "ready");
  assert.equal(w.base_commit, POD_COMMIT);
  assert.equal(w.node, "node-a");
  assert.ok(kube.untarBytes > 0, "the source went over exec stdin");

  // A call still within its time limit keeps the pod past the idle limit.
  const iso = (t: number) => new Date(t).toISOString();
  const call = (await db.get(db.k.insertInto("workspace_calls")
    .values({ workspace_id: id, n: 99, tool: "shell", state: "running", created_at: iso(clock), started_at: iso(clock), deadline_at: iso(clock + 2 * IDLE_PARK_MS) }).returning("id")))!.id;
  clock += IDLE_PARK_MS + 60_000;
  await pass();
  assert.equal((await getWorkspace(db, id))!.state, "ready", "a running call keeps the workspace from parking");
  await db.run(db.k.updateTable("workspace_calls").set({ state: "done" }).where("id", "=", call));

  await pass();
  w = (await getWorkspace(db, id))!;
  assert.equal(w.state, "parked");
  assert.equal(w.pod, null);
  assert.ok(!kube.pods.has(`ws-${id}`), "the parked workspace's pod is deleted");
  assert.ok(kube.pvcs.has(`ws-${id}`), "its volume is kept");
  assert.deepEqual(Buffer.from((await getCheckpoint(db, id))!), DIFF);
  const run = kube.execs.find((a) => a[1] === "run")!;
  assert.ok(run.includes(POD_COMMIT), "the checkpoint diffs against the pod's base commit");
  const calls = await db.all(db.k.selectFrom("workspace_calls").select(["tool", "state", "n"]).where("workspace_id", "=", id).where("tool", "!=", "shell").orderBy("id"));
  assert.equal(calls[0]?.tool, "seed");
  assert.ok(calls.length > 1 && calls.slice(1).every((c) => c.tool === "checkpoint" && c.state === "done" && c.n! > 0), "seeding and checkpoints are recorded");

  clock += PARKED_VOLUME_MS + 60_000;
  await pass();
  w = (await getWorkspace(db, id))!;
  assert.equal(w.state, "parked");
  assert.equal(w.pvc, null);
  assert.ok(!kube.pvcs.has(`ws-${id}`), "the parked volume is deleted after its keep time");
  assert.ok((await getCheckpoint(db, id))?.length, "the checkpoint stays");
});

const iso = (t: number) => new Date(t).toISOString();

/** A new workspace, started and seeded. */
async function readyWorkspace(): Promise<number> {
  const id = await createWorkspace(db, { repo: "open-app", baseSha: SHA, envId: "pods", owner: "cli" }, clock);
  await pass();
  kube.run(`ws-${id}`);
  await pass();
  assert.equal((await getWorkspace(db, id))!.state, "ready");
  return id;
}

test("a background command the session has not seen end keeps the workspace from parking", async () => {
  const id = await readyWorkspace();
  const done = (tool: string, acct: object) => db.run(db.k.insertInto("workspace_calls").values({
    workspace_id: id, n: 7, tool, state: "done", result: JSON.stringify({ text: "", acct }), created_at: iso(clock), started_at: iso(clock), finished_at: iso(clock),
  }).returning("id"));
  const bg = Number((await db.get(db.k.insertInto("workspace_calls").values({
    workspace_id: id, n: 7, tool: "shell", state: "done", result: JSON.stringify({ text: "{}", acct: { bg: 1, limit: 3 * 3600 } }), created_at: iso(clock), started_at: iso(clock), finished_at: iso(clock),
  }).returning("id")))!.id);
  clock += IDLE_PARK_MS + 60_000;
  await pass();
  assert.equal((await getWorkspace(db, id))!.state, "ready", "the background command holds the pod");
  await done("shell_status", { ref: bg, ms: 1000, bytes: 0, ended: 0 });
  await pass();
  assert.equal((await getWorkspace(db, id))!.state, "ready", "a status that saw it running does not let it go");
  await done("shell_status", { ref: bg, ms: 2000, bytes: 0, ended: 1 });
  await pass();
  assert.equal((await getWorkspace(db, id))!.state, "parked", "parked once the session saw it end");
});

test("a parked workspace comes back for its bound call: on its volume, else rebuilt from base and checkpoint", async () => {
  const id = await readyWorkspace();
  clock += IDLE_PARK_MS + 60_000;
  await pass();
  let w = (await getWorkspace(db, id))!;
  assert.equal(w.state, "parked");
  const base = w.base_commit;

  // A follow-up turn's call is queued: the workspace resumes on its kept volume, under a new pod name.
  const call = () => queueWorkspaceCall(db, { workspaceId: id, promptId: "workspace.try", promptVersion: "1", model: "opus", tier: "top", effort: "medium", stdin: "x", timeoutSeconds: 600, maxTurns: 5, items: [] });
  const first = await call();
  await pass();
  await pass();
  w = (await getWorkspace(db, id))!;
  assert.equal(w.state, "starting");
  assert.notEqual(w.pod, `ws-${id}`, "the new pod has a name of its own");
  assert.equal(w.pvc, `ws-${id}`, "on the kept volume");
  kube.run(w.pod!);
  const untars = kube.execs.filter((a) => a[1] === "untar").length;
  await pass();
  w = (await getWorkspace(db, id))!;
  assert.equal(w.state, "ready");
  assert.equal(w.base_commit, base, "the kept tree and its base commit are used as they are");
  assert.equal(kube.execs.filter((a) => a[1] === "untar").length, untars, "nothing is seeded again");

  // Parked again, its volume goes after the keep time; the next call rebuilds the tree and applies the checkpoint.
  await db.run(db.k.updateTable("remote_calls").set({ state: "done" }).where("id", "=", first));
  clock += IDLE_PARK_MS + 60_000;
  await pass();
  clock += PARKED_VOLUME_MS + 60_000;
  await pass();
  w = (await getWorkspace(db, id))!;
  assert.equal(w.state, "parked");
  assert.equal(w.pvc, null);
  await call();
  await pass();
  await pass();
  w = (await getWorkspace(db, id))!;
  assert.equal(w.state, "starting");
  assert.ok(w.pvc && kube.pvcs.has(w.pvc), "a new volume");
  kube.run(w.pod!);
  await pass();
  w = (await getWorkspace(db, id))!;
  assert.equal(w.state, "ready");
  assert.ok(kube.execs.filter((a) => a[1] === "untar").length > untars, "the base is seeded again");
  assert.deepEqual(kube.put, DIFF, "the checkpoint goes into the pod");
  assert.ok(kube.execs.some((a) => a.includes("apply") && a.includes("--binary")), "and is applied");
  assert.equal(w.restored?.split(" ")[0], "checkpoint");
});

/** A workspace parked after it sat idle, with a session call queued for it (so the launcher resumes it). */
async function parkedWithCall(): Promise<number> {
  const id = await readyWorkspace();
  clock += IDLE_PARK_MS + 60_000;
  await pass();
  assert.equal((await getWorkspace(db, id))!.state, "parked");
  await queueWorkspaceCall(db, { workspaceId: id, promptId: "workspace.try", promptVersion: "1", model: "opus", tier: "top", effort: "medium", stdin: "x", timeoutSeconds: 600, maxTurns: 5, items: [] });
  return id;
}

test("a kept volume is only checked, never seeded again; a resume that fails goes back to parked with it", async () => {
  const id = await parkedWithCall();
  const volume = (await getWorkspace(db, id))!.pvc!;
  const untars = kube.execs.filter((a) => a[1] === "untar").length;
  kube.kept = false;
  for (let i = 1; i <= RESUME_TRIES; i++) {
    await pass();
    const w = (await getWorkspace(db, id))!;
    assert.equal(w.state, "starting", `resume ${i} starts`);
    assert.equal(w.pvc, volume, "on the kept volume");
    kube.run(w.pod!);
    await pass();
    const back = (await getWorkspace(db, id))!;
    assert.equal(back.state, "parked", "a volume without the base commit sends it back to parked");
    assert.equal(back.pvc, volume);
    assert.equal(back.resume_tries, i);
    assert.ok(kube.pvcs.has(volume), "the volume is kept");
  }
  assert.equal(kube.execs.filter((a) => a[1] === "untar").length, untars, "the kept volume is never seeded or wiped");
  assert.ok(!kube.execs.some((a) => a.includes("-delete")), "nor emptied");
  await pass();
  assert.equal((await getWorkspace(db, id))!.state, "parked", "after its tries it stays parked");
  assert.equal(await resumeWorkspace(db, id), false);
  assert.match((await getWorkspace(db, id))!.error ?? "", /stays parked/);
  kube.kept = true;
});

test("a kept volume is dropped only when its node is gone, and never while it holds work no checkpoint has", async () => {
  const id = await readyWorkspace();
  // The checkpoint at parking fails: the volume is the only copy of the latest work and outlives the keep time.
  kube.checkpointFails = true;
  clock += IDLE_PARK_MS + 60_000;
  await pass();
  kube.checkpointFails = false;
  let w = (await getWorkspace(db, id))!;
  assert.equal(w.state, "parked");
  assert.ok(w.checkpoint_error);
  clock += PARKED_VOLUME_MS + 60_000;
  await pass();
  w = (await getWorkspace(db, id))!;
  const volume = w.pvc!;
  assert.ok(volume && kube.pvcs.has(volume), "kept past the keep time");

  await queueWorkspaceCall(db, { workspaceId: id, promptId: "workspace.try", promptVersion: "1", model: "opus", tier: "top", effort: "medium", stdin: "x", timeoutSeconds: 600, maxTurns: 5, items: [] });
  const unscheduled = async (message: string) => {
    await pass();
    const s = (await getWorkspace(db, id))!;
    assert.equal(s.state, "starting");
    kube.unschedulable(s.pod!, message);
    clock += RESUME_PENDING_MS + 60_000;
    await pass();
    return (await getWorkspace(db, id))!;
  };
  // A full node is waited for.
  w = await unscheduled("0/3 nodes are available: 1 Insufficient cpu, 2 node(s) had volume node affinity conflict.");
  assert.equal(w.state, "starting");
  assert.equal(w.pvc, volume, "a full node keeps the volume");

  // The node is gone, but the last checkpoint failed: back to parked with the volume.
  kube.nodes.set("node-a", { metadata: { name: "node-a" }, status: { conditions: [{ type: "Ready", status: "Unknown", lastTransitionTime: iso(clock - NODE_LOST_MS - 60_000) }] } });
  await pass();
  w = (await getWorkspace(db, id))!;
  assert.equal(w.state, "parked");
  assert.equal(w.pvc, volume);
  assert.ok(kube.pvcs.has(volume), "never dropped while it holds work no checkpoint has");

  // With a good checkpoint, a node that is gone loses its volume and the workspace rebuilds on a new one.
  await db.run(db.k.updateTable("workspaces").set({ checkpoint: DIFF, checkpoint_at: iso(clock), checkpoint_error: null }).where("id", "=", id));
  kube.nodes.delete("node-a");
  w = await unscheduled("0/2 nodes are available: 2 node(s) had volume node affinity conflict.");
  assert.equal(w.state, "starting");
  assert.notEqual(w.pvc, volume);
  assert.equal(w.volume_fresh, 1);
  assert.ok(!kube.pvcs.has(volume), "the lost volume is deleted");
  kube.nodes.set("node-a", { metadata: { name: "node-a" }, status: { conditions: [{ type: "Ready", status: "True" }] } });
  await pass();
  kube.run((await getWorkspace(db, id))!.pod!);
  await pass();
  w = (await getWorkspace(db, id))!;
  assert.equal(w.state, "ready");
  assert.equal(w.restored?.split(" ")[0], "checkpoint", "rebuilt from the checkpoint");
});
