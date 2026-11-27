// A workspace of a repository whose warm target is on the volume (photocraft's case) starts from the warm version a node
// holds: the pod mounts that node's warm claim and copies before the workspace starts, its volume is sized for the target
// to grow, and seeding sets the checkout's mtimes from the files changed since the warm commit. A warm version built from
// another Cargo.lock than the base commit's is not used: that workspace starts cold.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { createEnv } from "../src/build/envs.ts";
import type { ExecOptions, ExecResult, KConfigMap, KPod, KubeApi } from "../src/build/kube-api.ts";
import { ciCheckout, quantity } from "../src/build/pods.ts";
import { warmKeyOf } from "../src/build/tasks.ts";
import { WARM_COPY_CONTAINER } from "../src/build/warm-mount.ts";
import { recordWarmBytes } from "../src/build/warm-queue.ts";
import { WarmStatus } from "../src/build/warm-status.ts";
import { workspacePass, WorkspaceState } from "../src/build/workspace-launch.ts";
import { LAYOUT_CI, WARM_CHANGED_FILES, warmOf, workspaceEnvHash } from "../src/build/workspace-layout.ts";
import { WS_POD_PATH } from "../src/build/workspace.ts";
import { createWorkspace, getWorkspace } from "../src/build/workspaces.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { STATUS_DATA_KEY, STATUS_LABEL } from "../src/warm/sync-agent.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "workspace-warm-"));
process.env.AUTOCRAFT_FIXUP_DIR = join(dir, "fixups");
const db = await connectDb(join(dir, "ws.db"));
const REPO = "photocraft";
await db.script(`INSERT INTO tracked_repos (name, pipeline) VALUES ('${REPO}', 1) ON CONFLICT DO NOTHING; INSERT INTO repos (name, visibility) VALUES ('${REPO}', 'public') ON CONFLICT DO NOTHING;
  INSERT INTO build_sizes (repo, memory_request_bytes, memory_limit_bytes, updated_at, reason, warm_target) VALUES ('${REPO}', 1, 2, '2026-01-01T00:00:00Z', 'op', 'pvc')`);
after(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

// AutoCraft's clone: the warm commit, then the base commit, which changes one source file.
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
const src = join(dir, "src");
mkdirSync(join(src, "crates", "a"), { recursive: true });
const LOCK = "version = 4\n";
writeFileSync(join(src, "Cargo.lock"), LOCK);
writeFileSync(join(src, "crates", "a", "lib.rs"), "pub fn a() {}\n");
writeFileSync(join(src, "crates", "a", "other.rs"), "pub fn b() {}\n");
const commit = (m: string) => {
  git(src, "add", "-A");
  git(src, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", m);
  return git(src, "rev-parse", "HEAD");
};
git(src, "init", "-q");
const WARM = commit("warm");
writeFileSync(join(src, "crates", "a", "lib.rs"), "pub fn a() { changed(); }\n");
const BASE = commit("base");
mkdirSync(join(dir, "fixups"));
git(dir, "clone", "-q", "--bare", src, join(dir, "fixups", REPO));

const KEY = warmKeyOf(REPO);
const WARM_BYTES = 27e9;
await recordWarmBytes(db, KEY, WARM_BYTES);
const IMAGE = "rust-stable:test";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
// The repo has no CI gate (every gate file is a 404), so its env hash is the stock one.
const ENV_HASH = workspaceEnvHash({ env: {}, craftFontsRef: null, craftI18nRev: null, cacheVersion: null, cargoLock: null });

type Pod = Omit<KPod, "spec"> & { spec: Record<string, any> };
const matches = (labels: Record<string, string> | undefined, selector: string) => selector.split(",").every((kv) => labels?.[kv.split("=")[0]!] === kv.split("=")[1]);

class FakeKube implements KubeApi {
  pods = new Map<string, Pod>();
  pvcs = new Map<string, { metadata: { name: string; labels?: Record<string, string> }; spec: { resources: { requests: { storage: string } } } }>();
  execs: { argv: string[]; stdin: string }[] = [];
  /** What warm-copy left on the volume. */
  mark: object | null = null;
  async getNode() { return null; }
  async listPods(_ns: string, sel: string) { return [...this.pods.values()].filter((p) => matches(p.metadata.labels, sel)); }
  async createPod(_ns: string, pod: object) { const p = structuredClone(pod) as Pod; this.pods.set(p.metadata.name, { ...p, status: { phase: "Pending" } }); }
  async deletePod(_ns: string, name: string) { this.pods.delete(name); }
  async podLog() { return ""; }
  async listPvcs(_ns: string, sel: string) { return [...this.pvcs.values()].filter((v) => matches(v.metadata.labels, sel)); }
  async createPvc(_ns: string, pvc: object) { const v = structuredClone(pvc) as any; this.pvcs.set(v.metadata.name, v); }
  async deletePvc(_ns: string, name: string) { this.pvcs.delete(name); }
  async canI() { return true; }
  async exec(_ns: string, _pod: string, _container: string, argv: string[], opts: ExecOptions): Promise<ExecResult> {
    const chunks: Buffer[] = [];
    const input = opts.stdin ?? Buffer.alloc(0);
    for await (const c of Buffer.isBuffer(input) ? [input] : input) chunks.push(c);
    this.execs.push({ argv, stdin: Buffer.concat(chunks).toString("latin1") });
    const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), truncated: false });
    if (argv[0] === WS_POD_PATH && argv[1] === "untar") return ok(`WS ok ${"c".repeat(40)}\n`);
    if (argv[0] === WS_POD_PATH && argv[1] === "run") return ok("WS exited 0 15 0\n");
    if (argv[0] === WS_POD_PATH && argv[1] === "put") return ok(`WS ok 1 ${"d".repeat(64)}\n`);
    if (argv[0] === "cat") return this.mark ? ok(JSON.stringify(this.mark)) : { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("no such file"), truncated: false };
    return { exitCode: 2, stdout: Buffer.from("WS error usage unknown\n"), stderr: Buffer.alloc(0), truncated: false };
  }
  run(name: string, node: string) {
    const p = this.pods.get(name)!;
    p.spec.nodeName = node;
    p.status = { phase: "Running", containerStatuses: (p.spec.containers as { name: string }[]).map((c) => ({ name: c.name, ready: true, state: { running: { startedAt: "2026-01-01T00:00:00Z" } } })) };
  }
}

let clock = Date.now();
const kube = new FakeKube();
// node-b holds the key, built with the workspace's image and env.
let lock = sha256(LOCK);
let usedPct = 10;
const statusCm = (): KConfigMap => ({
  metadata: { name: "warm-status-node-b", labels: { [STATUS_LABEL]: "node" } },
  data: { [STATUS_DATA_KEY]: JSON.stringify({ version: 1, node: "node-b", updated: clock, fs: { sizeBytes: 1e12, usedBytes: 1e11, usedPct: usedPct }, keys: { [KEY]: { commit: WARM, stored: 1, bytes: WARM_BYTES, image: IMAGE, envHash: ENV_HASH, synced: 1, cargoLock: lock } } }) },
});
const state = new WorkspaceState();
state.warm = new WarmStatus({ listConfigMaps: async () => [statusCm()] }, { now: () => clock });
const fetchImpl = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
const deps = { db, api: kube, defaultImage: null, log: () => {}, now: () => clock, fetchImpl };
const pass = async () => {
  await state.warm!.refresh(true);
  await workspacePass(deps, state);
  await state.idle();
};

await createEnv(db, { id: "pods", label: "Pods", kind: "kubernetes", slots: 2, settings: { image: "autocraft:test", toolchainImages: { "rust-stable": IMAGE } } }, "op");

test("a workspace whose repo has a warm version on a node starts warm on that node; another Cargo.lock starts it cold", async () => {
  const checkout = ciCheckout(REPO)!;
  const id = await createWorkspace(db, { repo: REPO, baseSha: BASE, envId: "pods", owner: "cli" }, clock);
  assert.equal((await getWorkspace(db, id))!.layout, LAYOUT_CI);
  await pass(); // reads the CI gate
  await pass(); // starts
  let w = (await getWorkspace(db, id))!;
  assert.equal(w.state, "starting");
  const spec = kube.pods.get(w.pod!)!.spec;
  const copy = (spec.initContainers as { name: string; env: { name: string; value: string }[] }[]).find((c) => c.name === WARM_COPY_CONTAINER);
  assert.ok(copy, "warm-copy runs before the workspace");
  const env = Object.fromEntries(copy.env.map((e) => [e.name, e.value]));
  assert.equal(env.AUTOCRAFT_WARM_COMMIT, WARM);
  assert.equal(env.AUTOCRAFT_WARM_SAME_LOCK, "1", "a target on the volume needs the same Cargo.lock");
  assert.equal(env.AUTOCRAFT_WARM_CARGO_LOCK, sha256(LOCK));
  assert.ok(spec.volumes.some((v: any) => v.persistentVolumeClaim?.claimName === "craft-warm-node-b" && v.persistentVolumeClaim.readOnly), "the node's warm claim, which pins the pod there");
  const main = spec.containers[0];
  const mainEnv = Object.fromEntries((main.env as { name: string; value: string }[]).map((e) => [e.name, e.value]));
  assert.equal(mainEnv.CARGO_HOME, "/cache/cargo");
  assert.equal(mainEnv.CARGO_TARGET_DIR, undefined, "the target is the checkout's own, as in CI");
  assert.ok(main.volumeMounts.some((m: any) => m.mountPath === checkout), "the checkout is at the CI path");
  const storage = quantity(kube.pvcs.get(w.pvc!)!.spec.resources.requests.storage);
  assert.ok(storage > 2 * WARM_BYTES, "the volume has room for the target to grow");

  kube.mark = { state: "done", commit: WARM, trimmed: true, bytes: WARM_BYTES, secs: 84 };
  kube.run(w.pod!, "node-b");
  await pass();
  w = (await getWorkspace(db, id))!;
  assert.equal(w.state, "ready");
  assert.equal(w.warm_commit, WARM);
  assert.match(warmOf(w)!.note!, /^warm copy 27\.0 GB in 84 s/);
  const changed = kube.execs.find((e) => e.argv[1] === "put" && e.argv[2] === WARM_CHANGED_FILES)!;
  assert.deepEqual(changed.stdin.split("\0"), ["crates/a/lib.rs"], "only the file changed since the warm commit counts as changed");
  assert.ok(kube.execs.some((e) => e.argv[1] === "run" && e.argv.at(-1) === "list"), "the other files keep old mtimes");

  // The node's version was built from another Cargo.lock.
  lock = sha256("version = 3\n");
  kube.mark = null;
  const cold = await createWorkspace(db, { repo: REPO, baseSha: BASE, envId: "pods", owner: "cli" }, clock);
  await pass();
  await pass();
  let c = (await getWorkspace(db, cold))!;
  const coldSpec = kube.pods.get(c.pod!)!.spec;
  assert.ok(!coldSpec.initContainers.some((x: { name: string }) => x.name === WARM_COPY_CONTAINER), "no copy");
  assert.ok(!coldSpec.volumes.some((v: any) => v.persistentVolumeClaim?.claimName.startsWith("craft-warm-")), "no warm claim");
  kube.run(c.pod!, "node-a");
  await pass();
  c = (await getWorkspace(db, cold))!;
  assert.equal(c.state, "ready");
  assert.equal(c.warm_commit, null);
  assert.match(warmOf(c)!.note!, /^started cold: .*Cargo\.lock/);
});

test("a tmpfs warm target still puts a workspace's target on its volume, and a nearly full node is skipped", async () => {
  await db.script(`UPDATE build_sizes SET warm_target = 'tmpfs' WHERE repo = '${REPO}'`);
  lock = sha256(LOCK);
  const warmPod = async () => {
    const id = await createWorkspace(db, { repo: REPO, baseSha: BASE, envId: "pods", owner: "cli" }, clock);
    await pass();
    await pass();
    return kube.pods.get((await getWorkspace(db, id))!.pod!)!.spec;
  };
  const spec = await warmPod();
  assert.ok(spec.initContainers.some((x: { name: string }) => x.name === WARM_COPY_CONTAINER), "starts warm");
  assert.ok(!spec.volumes.some((v: any) => v.name === "warm-target"), "no memory-backed target");
  assert.ok(spec.containers[0].volumeMounts.some((m: any) => m.mountPath.endsWith("/target") && m.name === "work"), "the target is on the volume");

  usedPct = 90;
  const full = await warmPod();
  assert.ok(!full.initContainers.some((x: { name: string }) => x.name === WARM_COPY_CONTAINER), "a node over the disk limit starts the workspace cold");
});
