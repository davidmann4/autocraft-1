// The workspace tools against the real in-pod helper: a fake Kubernetes API runs deploy/container/ws locally, with /work
// mapped to a scratch directory. Edits refuse a missing or ambiguous match and a file that changed under them, long
// shell output comes back cut in the middle, writes keep a file's mode and go through links, shell time is counted by
// the job's clock whatever the call files say, app_start refuses bad arguments and a fifth app, and the call limit holds
// for a session rebuilt after a job restart. With Xvfb on the machine, the helper itself is run on a spare display: a
// repeated app-start starts one app, and env values the shell treats specially cannot stop it recording the app.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { createEnv } from "../src/build/envs.ts";
import type { ExecOptions, ExecResult, KPod, KubeApi } from "../src/build/kube-api.ts";
import { WS_POD_PATH } from "../src/build/workspace.ts";
import { SESSION_LIMITS, WorkspaceSession } from "../src/build/workspace-tools.ts";
import { createWorkspace, moveWorkspace } from "../src/build/workspaces.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "workspace-tools-"));
const root = join(dir, "work");
for (const d of ["src", "home", ".ws/calls"]) mkdirSync(join(root, d), { recursive: true });
const db = await connectDb(join(dir, "ws.db"));
after(async () => await db.close());
const helper = new URL("../deploy/container/ws", import.meta.url).pathname;
const local = (p: string) => (p === "/work" || p.startsWith("/work/") ? root + p.slice(5) : p);

class HelperKube implements Partial<KubeApi> {
  /** Runs before the helper for argv[1] === key, e.g. to change a file while an edit is under way. */
  before = new Map<string, () => void>();
  async listPods(): Promise<KPod[]> {
    return [{ metadata: { name: "ws-1", labels: { "craft.build/workspace": "1" } }, status: { phase: "Running" } } as KPod];
  }
  async exec(_ns: string, _pod: string, _c: string, argv: string[], o: ExecOptions): Promise<ExecResult> {
    assert.equal(argv[0], WS_POD_PATH);
    this.before.get(argv[1]!)?.();
    const p = spawn("sh", [helper, ...argv.slice(1).map(local)], { env: { ...process.env, WS_ROOT: root } });
    const out: Buffer[] = [];
    p.stdout.on("data", (b: Buffer) => out.push(b));
    p.stdin.end(Buffer.isBuffer(o.stdin) ? o.stdin : undefined);
    const code = await new Promise<number | null>((r) => p.on("close", r));
    return { exitCode: code, stdout: Buffer.concat(out), stderr: Buffer.alloc(0), truncated: false };
  }
}
const kube = new HelperKube();
const api = kube as unknown as KubeApi;

await createEnv(db, { id: "pods", label: "Pods", kind: "kubernetes", slots: 2, settings: { image: "autocraft:test" } }, "op");
await db.script("INSERT INTO tracked_repos (name, pipeline) VALUES ('open-app', 1)");
const ws = await createWorkspace(db, { repo: "open-app", baseSha: "a".repeat(40), envId: "pods", owner: "test" });
assert.equal(ws, 1);
await moveWorkspace(db, ws, ["requested"], "ready", { pod: "ws-1" });

const queue = async (tool: string, args: unknown, state = "queued") => Number((await db.get(db.k.insertInto("workspace_calls")
  .values({ workspace_id: ws, tool, args: JSON.stringify(args), state, created_at: new Date().toISOString() }).returning("id")))!.id);
const session = new WorkspaceSession(db, api, ws);
const call = async (tool: string, args: unknown) => await session.call(tool, args, await queue(tool, args));

test("edit replaces one exact match and refuses no match, several matches and a file changed under it", async () => {
  assert.ok(!(await call("write", { path: "lib.rs", content: "let a = 1;\nlet a = 1;\nlet b = 2;\n" })).isError);
  const file = join(root, "src/lib.rs");

  const none = await call("edit", { path: "lib.rs", old_string: "let c", new_string: "let d" });
  assert.ok(none.isError && /not found/.test(none.text), none.text);
  const many = await call("edit", { path: "/work/src/lib.rs", old_string: "let a = 1;", new_string: "let a = 3;" });
  assert.ok(many.isError && /2 times/.test(many.text), many.text);
  assert.equal(readFileSync(file, "utf8"), "let a = 1;\nlet a = 1;\nlet b = 2;\n", "a refused edit leaves the file alone");

  assert.ok(!(await call("edit", { path: "lib.rs", old_string: "let b = 2;", new_string: "let b = 5;" })).isError);
  assert.ok(!(await call("edit", { path: "lib.rs", old_string: "let a = 1;", new_string: "let a = 3;", replace_all: true })).isError);
  assert.equal(readFileSync(file, "utf8"), "let a = 3;\nlet a = 3;\nlet b = 5;\n");

  // Another writer changes the file between the edit's read and its write.
  kube.before.set("put", () => writeFileSync(file, "changed elsewhere\nlet b = 5;\n"));
  const raced = await call("edit", { path: "lib.rs", old_string: "let b = 5;", new_string: "let b = 6;" });
  kube.before.delete("put");
  assert.ok(raced.isError && /changed while/.test(raced.text), raced.text);
  assert.equal(readFileSync(file, "utf8"), "changed elsewhere\nlet b = 5;\n", "the other writer's change is kept");

  const outside = await call("edit", { path: "../../etc/passwd", old_string: "x", new_string: "y" });
  assert.ok(outside.isError && /below \/work/.test(outside.text), outside.text);
});

test("long shell output keeps its head and tail with the cut noted", async () => {
  const r = await call("shell", { command: "seq 1 40000; echo done >&2" });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /^exited 0 after /);
  assert.match(r.text, /bytes cut/);
  assert.ok(Buffer.byteLength(r.text) < 33 * 1024, `${Buffer.byteLength(r.text)} bytes`);
  assert.ok(r.text.includes("\n1\n2\n3\n"), "the head is kept");
  assert.ok(r.text.trimEnd().endsWith("40000\ndone"), "the tail is kept, stderr merged in order");
});

test("writes keep the file's mode and write through a link inside /work", async () => {
  const script = join(root, "src/run.sh");
  writeFileSync(script, "#!/bin/sh\necho one\n");
  chmodSync(script, 0o755);
  symlinkSync("run.sh", join(root, "src/link.sh"));
  assert.ok(!(await call("edit", { path: "link.sh", old_string: "one", new_string: "two" })).isError);
  assert.ok(lstatSync(join(root, "src/link.sh")).isSymbolicLink(), "the link stays a link");
  assert.equal(readFileSync(script, "utf8"), "#!/bin/sh\necho two\n");
  assert.equal(statSync(script).mode & 0o777, 0o755, "the exec bit is kept");
  symlinkSync("/etc/hostname", join(root, "src/out"));
  const out = await call("write", { path: "out", content: "x" });
  assert.ok(out.isError && /outside/.test(out.text), out.text);
});

test("shell time is the job's: a command that writes its own end into the call files is charged until the job sees it end", async () => {
  const fake = "n=$(ls ../.ws/calls | sed -n 's/[.]start$//p' | sort -n | tail -1); cp ../.ws/calls/$n.start ../.ws/calls/$n.end; echo 0 > ../.ws/calls/$n.exit; sleep 2";
  const started = Date.now();
  const { id } = JSON.parse((await call("shell", { command: fake, background: true })).text) as { id: number };
  await new Promise((r) => setTimeout(r, 1200));
  const st = await call("shell_status", { id });
  assert.match(st.text, /^exited 0 after/);
  const row = await db.get(db.k.selectFrom("workspace_calls").select("result").where("tool", "=", "shell_status").orderBy("id", "desc").limit(1));
  const charged = (JSON.parse(row!.result!) as { acct: { ms: number } }).acct.ms;
  assert.ok(charged >= Date.now() - started - 1000 && charged >= 1000, `charged ${charged} ms`);
});

test("app_start refuses names the workspace sets, too many args, a binary it cannot run and a fifth app", async () => {
  assert.ok(!(await call("write", { path: "notes.txt", content: "not a program\n" })).isError);
  const refusals: [unknown, RegExp][] = [
    [{ binary: "run.sh", env: { DISPLAY: ":1" } }, /cannot set DISPLAY/],
    [{ binary: "run.sh", env: { VK_ICD_FILENAMES: "x" } }, /cannot set VK_ICD_FILENAMES/],
    [{ binary: "run.sh", env: { lower: "x" } }, /must match/],
    [{ binary: "run.sh", args: Array.from({ length: 33 }, () => "x") }, /more than 32/],
    [{ binary: "run.sh", scale: 3 }, /scale must be/],
    [{ binary: "/etc/hostname" }, /below \/work/],
    [{ binary: "notes.txt" }, /not executable/],
  ];
  for (const [args, re] of refusals) {
    const r = await call("app_start", args);
    assert.ok(r.isError && re.test(r.text), r.text);
  }
  const shot = await call("screenshot", { region: { x: 0, y: 0, w: 0, h: 10 } });
  assert.ok(shot.isError && /region.w/.test(shot.text), shot.text);

  // Four apps the pod counts as running; this test's own process stands in for each.
  const apps = join(root, ".ws/apps");
  mkdirSync(apps, { recursive: true });
  for (let n = 9001; n <= 9004; n++) {
    writeFileSync(join(apps, `${n}.start`), "0\n");
    writeFileSync(join(apps, `${n}.pid`), `${process.pid}\n`);
  }
  const fifth = await call("app_start", { binary: "run.sh" });
  assert.ok(fifth.isError && /4 apps are running/.test(fifth.text), fifth.text);
});

const hasCommand = (c: string) => spawnSync("sh", ["-c", `command -v ${c}`]).status === 0;
test("app-start run twice with one call number starts one app, and the session's env cannot break the wrapper",
  { skip: hasCommand("Xvfb") && hasCommand("xmessage") ? false : "needs Xvfb and xmessage" }, () => {
    const wr = join(dir, "x11");
    for (const d of ["src", "home"]) mkdirSync(join(wr, d), { recursive: true });
    const display = Array.from({ length: 30 }, (_, i) => 170 + i).find((n) => !existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`));
    assert.ok(display, "a free display number");
    const ws = (...args: string[]) => spawnSync("sh", [helper, ...args], { env: { ...process.env, WS_ROOT: wr, WS_DISPLAY: String(display) }, encoding: "utf8" }).stdout;
    const marker = `ws-app-test-${process.pid}`;
    writeFileSync(join(wr, "src/app.sh"), `#!/bin/sh\nexec xmessage ${marker}\n`, { mode: 0o755 });
    writeFileSync(join(wr, "src/quit.sh"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    const apps = join(wr, ".ws/apps");
    try {
      const first = ws("app-start", "1", "1", join(wr, "src/app.sh"), "0", "--");
      assert.match(first, /^WS ok app /);
      const again = ws("app-start", "1", "1", join(wr, "src/app.sh"), "0", "--");
      assert.equal(again, first, "the second call reports the same app");
      const running = readdirSync("/proc").filter((d) => {
        try {
          return /^\d+$/.test(d) && readFileSync(`/proc/${d}/cmdline`, "latin1").includes(marker);
        } catch {
          return false;
        }
      });
      assert.equal(running.length, 1, "one app process");
      assert.deepEqual(readdirSync(apps).filter((f) => f.endsWith(".start") || f.endsWith(".pid")).sort(), ["1.pid", "1.start"]);

      const broken = ws("app-start", "2", "1", join(wr, "src/quit.sh"), "3", "OPTIND=x", "IFS=:", "PATH=/nonexistent", "--");
      assert.match(broken, /^WS ok exited \d+/);
      for (const f of ["2.pid", "2.exit"]) assert.ok(existsSync(join(apps, f)), `${f} is written`);
    } finally {
      ws("app-stop", "1", "--force");
      const xvfb = Number(readFileSync(join(wr, ".ws/xvfb.pid"), "utf8"));
      if (xvfb > 1) process.kill(xvfb);
    }
  });

test("a session rebuilt after a restart still counts the calls made before it", async () => {
  const done = await db.all(db.k.selectFrom("workspace_calls").select("id").where("workspace_id", "=", ws).where("state", "!=", "queued"));
  const at = new Date().toISOString();
  const rows = Array.from({ length: SESSION_LIMITS.calls - done.length }, () => ({ workspace_id: ws, tool: "read", args: "{}", state: "done", created_at: at }));
  for (let k = 0; k < rows.length; k += 500) await db.run(db.k.insertInto("workspace_calls").values(rows.slice(k, k + 500)));
  const fresh = new WorkspaceSession(db, api, ws);
  const r = await fresh.call("read", { path: "lib.rs" }, await queue("read", { path: "lib.rs" }));
  assert.ok(r.isError && /calls are used up/.test(r.text), r.text);
});
