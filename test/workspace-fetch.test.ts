// fetch_dependencies against a fake Kubernetes API: a workspace whose environment has no crate mirror is refused before
// any pod is made; with one, the fetch pod runs on the workspace's volume with network `mirror` and the mirror's
// hostAliases, and the tool returns the Cargo.lock diff against the base commit (git run on a local checkout standing in
// for /work/src) and deletes the pod.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { createEnv } from "../src/build/envs.ts";
import type { ExecOptions, ExecResult, KPod, KubeApi } from "../src/build/kube-api.ts";
import { WorkspaceSession } from "../src/build/workspace-tools.ts";
import { createWorkspace, moveWorkspace } from "../src/build/workspaces.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "workspace-fetch-"));
const src = join(dir, "src");
mkdirSync(src);
const git = (...args: string[]) => spawnSync("git", ["-C", src, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
git("init", "-q");
writeFileSync(join(src, "Cargo.lock"), "version = 4\n");
writeFileSync(join(src, "Cargo.toml"), "[package]\nname = \"app\"\n");
git("add", ".");
git("commit", "-q", "-m", "base");
const base = git("rev-parse", "HEAD").stdout.trim();

const db = await connectDb(join(dir, "ws.db"));
after(async () => await db.close());

type Spec = { metadata: { name: string; labels: Record<string, string> }; spec: { hostAliases?: { ip: string }[]; volumes: { persistentVolumeClaim?: { claimName: string } }[] } };

class FakeKube implements Partial<KubeApi> {
  created: Spec[] = [];
  readonly live = new Map<string, Spec>();
  async listPods(_ns: string, selector: string): Promise<KPod[]> {
    if (selector.includes("craft.build/workspace=")) {
      const id = selector.split("craft.build/workspace=")[1]!;
      return [{ metadata: { name: `ws-${id}`, labels: { "craft.build/workspace": id } }, status: { phase: "Running" } } as KPod];
    }
    return [...this.live.values()].map((p) => ({
      metadata: { name: p.metadata.name, labels: p.metadata.labels },
      status: { phase: "Succeeded", containerStatuses: [{ name: "fetch", state: { terminated: { exitCode: 0 } } }] },
    }) as KPod);
  }
  async createPod(_ns: string, pod: object): Promise<void> {
    const p = pod as Spec;
    this.created.push(p);
    this.live.set(p.metadata.name, p);
    // What cargo fetch does to the checkout on the volume.
    appendFileSync(join(src, "Cargo.lock"), "\n[[package]]\nname = \"itoa\"\nversion = \"1.0.11\"\n");
  }
  async deletePod(_ns: string, name: string): Promise<void> {
    this.live.delete(name);
  }
  async podLog(): Promise<string> {
    return "    Locking 1 package to latest compatible version\n";
  }
  async exec(_ns: string, _pod: string, _c: string, argv: string[], _o: ExecOptions): Promise<ExecResult> {
    assert.equal(argv[0], "git");
    const r = spawnSync("git", argv.slice(1).map((a) => (a === "/work/src" ? src : a)), { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr, truncated: false };
  }
}
const kube = new FakeKube();
const api = kube as unknown as KubeApi;

const settings = { image: "autocraft:test", toolchainImages: { "rust-stable": "toolchain:test" } };
await createEnv(db, { id: "plain", label: "Plain", kind: "kubernetes", slots: 2, settings }, "op");
await createEnv(db, { id: "mirrored", label: "Mirrored", kind: "kubernetes", slots: 2, settings: { ...settings, crateMirror: "10.43.0.9" } }, "op");
await db.script("INSERT INTO tracked_repos (name, pipeline) VALUES ('open-app', 1)");

const workspace = async (envId: string): Promise<number> => {
  const id = await createWorkspace(db, { repo: "open-app", baseSha: base, envId, owner: "test" });
  await moveWorkspace(db, id, ["requested"], "ready", { pod: `ws-${id}`, pvc: `ws-${id}`, base_commit: base });
  return id;
};
const call = async (ws: number, args: unknown) => {
  const row = Number((await db.get(db.k.insertInto("workspace_calls")
    .values({ workspace_id: ws, tool: "fetch_dependencies", args: JSON.stringify(args), state: "queued", created_at: new Date().toISOString() }).returning("id")))!.id);
  return await new WorkspaceSession(db, api, ws).call("fetch_dependencies", args, row);
};

test("fetch_dependencies refuses without a crate mirror and returns the Cargo.lock diff through one", async () => {
  const plain = await workspace("plain");
  const no = await call(plain, {});
  assert.ok(no.isError && /no crate mirror/.test(no.text), no.text);
  assert.equal(kube.created.length, 0, "no pod is made without a mirror");

  const ws = await workspace("mirrored");
  const r = await call(ws, {});
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /\+name = "itoa"/);
  assert.equal(kube.created.length, 1);
  const pod = kube.created[0]!;
  assert.equal(pod.metadata.labels["craft.build/network"], "mirror");
  assert.equal(pod.spec.hostAliases?.[0]?.ip, "10.43.0.9");
  assert.ok(pod.spec.volumes.some((v) => v.persistentVolumeClaim?.claimName === `ws-${ws}`), "the pod mounts the workspace's volume");
  assert.equal(kube.live.size, 0, "the fetch pod is deleted afterwards");
});
