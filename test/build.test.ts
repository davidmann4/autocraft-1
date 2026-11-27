// Build environments: claim matching, lost workers, cancels, worker key auth, size caps,
// the artifact type allowlist, and the dashboard API (visibility, operator-only writes, downloads).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { BuildTaskDetail, TaskPage } from "../web/src/api/types.ts";
import { addLogin } from "../src/access.ts";
import { sniff } from "../src/build/artifacts.ts";
import { authenticate, BuildError, createEnv, hello, listEnvs, rotateKey, updateEnv } from "../src/build/envs.ts";
import { setCallContext } from "../src/agents/call.ts";
import { loadClaimInputs } from "../src/data/build/index.ts";
import { appendLog, MAX_LOG_BYTES, cancelTask, claim, cloneTask, createTask, finishTask, getTask, pickTasks } from "../src/build/tasks.ts";
import { startWorkerServer } from "../src/build/worker-api.ts";
import { useRunnerClient } from "../src/remote/runner-client.ts";
import { apiRoutes } from "../src/dash/api/index.ts";
import { loadConfig } from "../src/dash/server/config.ts";
import { startServer } from "../src/dash/server/index.ts";
import { FakeProvider } from "../src/dash/server/provider.ts";
import { scopeToTracked } from "../src/repos.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "build-test-"));
process.env.AUTOCRAFT_ARTIFACT_DIR = join(dir, "artifacts");
const db = await connectDb(join(dir, "build.db"));
const SHA = "a".repeat(40);
const PLAN = [{ name: "t", cmd: ["true"], network: "none" as const, timeoutSec: 10 }];
const CAPS = { os: "linux", arch: "x86_64", cpus: 8, memGb: 32, diskGb: 200, display: false, gpu: false, toolchains: ["rust-stable", "node-24"] };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);

let n = 0;
/** A registered, enabled environment that has said hello. */
async function env(opts: { slots?: number; caps?: Partial<typeof CAPS>; enabled?: boolean } = {}) {
  const id = `env-${++n}`;
  const key = (await createEnv(db, { id, label: id, kind: "local-sandbox", slots: opts.slots ?? 2 }, "op")).key!;
  await hello(db, id, { version: "1.0", capabilities: { ...CAPS, ...opts.caps }, slots: 8 });
  if (opts.enabled === false) await updateEnv(db, id, { enabled: false }, "op");
  return { id, key };
}
const task = async (over: Partial<Parameters<typeof createTask>[1]> = {}) => await createTask(db, { step: "verify", repo: "open-app", headSha: SHA, plan: PLAN, ...over });
const clear = async () => {
  await db.run(db.k.deleteFrom("build_tasks"));
  await db.run(db.k.deleteFrom("build_task_logs"));
  await db.run(db.k.deleteFrom("build_artifacts"));
};

before(async () => {
  await db.run(db.k.insertInto("tracked_repos").values([{ name: "open-app", pipeline: 1 }, { name: "vault", pipeline: 0 }]));
  await db.run(db.k.insertInto("repos").values([{ name: "open-app", visibility: "public" }, { name: "vault", visibility: "internal" }]));
});
after(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("task source", () => {
});

describe("claim", () => {






});

describe("lost workers and cancels", () => {


});

describe("finishing", () => {
  test("a task the runner stopped for a reason no step shows is failed, though every step result passed", async () => {
    await clear();
    const e = await env();
    const id = await task();
    await claim(db, e.id, 1);
    const ok = { step: "t", exitCode: 0, durationMs: 1, timedOut: false };
    assert.equal((await finishTask(db, e.id, id, { results: [ok], summary: "the warm restore failed", failed: true })).state, "failed");
    const id2 = await task();
    await claim(db, e.id, 1);
    assert.equal((await finishTask(db, e.id, id2, { results: [ok], summary: "1 step passed" })).state, "done");
  });
});

describe("worker API", () => {
  let url = "";
  let close: () => Promise<void>;
  before(async () => {
    const w = await startWorkerServer({ db, listen: "127.0.0.1:0" });
    url = w.url;
    close = w.close;
  });
  after(() => close());
  const call = (key: string | null, path: string, body?: unknown, method = "POST", type = "application/json") =>
    fetch(`${url}${path}`, {
      method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { "content-type": type } : {}) },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? new Uint8Array(body) : typeof body === "string" ? body : JSON.stringify(body),
    });

  test("a batch build in a repo that is off is claimed only when a person started every member", async () => {
    await clear();
    const e = await env();
    await task({ repo: "vault" });
    const read = await loadClaimInputs(db, e.id, Date.now());
    const pick = async (members: number[]) => {
      const inputs = { ...read, startedRefs: new Set(["vault#1"]) as typeof read.startedRefs, batches: new Map(read.candidates.map((t) => [t.id, { repo: "vault", members }])) as unknown as typeof read.batches };
      return (await pickTasks(db, e.id, 1, Date.now(), { inputs })).picks.length;
    };
    assert.equal(await pick([1, 2]), 0);
    assert.equal(await pick([1]), 1);
    assert.equal(await pick([]), 0);
  });

  test("a task queued again belongs to the job that queues it, and a full queue refuses it as a status error", async () => {
    await clear();
    const id = await task();
    setCallContext({ jobId: 77, step: "verify", stage: 5, class: 0, cancelled: async () => false });
    try {
      assert.equal((await getTask(db, await cloneTask(db, id)))!.jobId, 77);
    } finally { setCallContext(null); }
    await db.run(db.k.insertInto("build_tasks").values(Array.from({ length: 500 }, () => ({ step: "verify", repo: "open-app", head_sha: SHA, requires: "{}", plan: "[]", state: "queued", queued_at: "2026-01-01T00:00:00Z" }))));
    await assert.rejects(cloneTask(db, id), (e: BuildError) => e instanceof BuildError && e.status === 429);
    await clear();
  });

  test("keys: missing, wrong, other environment's and rotated keys are refused", async () => {
    const a = await env(), b = await env();
    assert.equal((await call(null, "/worker/claim", { free: 1 })).status, 401);
    assert.equal((await call("cwk_nope_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "/worker/claim", { free: 1 })).status, 401);
    assert.equal((await call(a.key.slice(0, -1) + "x", "/worker/claim", { free: 1 })).status, 401);
    assert.equal((await call(a.key, "/worker/claim", { free: 1 })).status, 200);
    assert.equal((await authenticate(db, a.key))!.id, a.id);
    assert.equal((await authenticate(db, b.key))!.id, b.id);
    const { key } = await rotateKey(db, a.id, "op");
    assert.equal((await call(a.key, "/worker/claim", { free: 1 })).status, 401);
    assert.equal((await call(key, "/worker/claim", { free: 1 })).status, 200);
    assert.ok(!(await db.get(db.k.selectFrom("build_envs").select("key_hash").where("id", "=", a.id)))!.key_hash.includes(key));   // only a hash is stored
  });

  test("a task of another environment cannot be touched", async () => {
    await clear();
    const a = await env(), b = await env();
    const id = await task();
    await claim(db, a.id, 1);
    assert.equal((await call(b.key, `/worker/tasks/${id}/heartbeat`)).status, 409);
    assert.equal((await call(b.key, `/worker/tasks/${id}/log`, { step: "t", chunk: "x" })).status, 409);
    assert.equal((await call(a.key, `/worker/tasks/${id}/start`)).status, 200);
  });



  test("log appends stop at the cap and the stored bytes never pass it", async () => {
    await clear();
    const e = await env();
    const id = await task();
    await claim(db, e.id, 1);
    const chunk = "x".repeat(60 * 1024);
    let last = { truncated: false };
    for (let i = 0; i < Math.ceil(MAX_LOG_BYTES / chunk.length) + 3; i++) last = await appendLog(db, e.id, id, "t", chunk);
    assert.equal(last.truncated, true);
    assert.equal((await db.get(db.k.selectFrom("build_tasks").select("log_bytes").where("id", "=", id)))!.log_bytes, MAX_LOG_BYTES);
    const stored = (await db.get(db.k.selectFrom("build_task_logs").select((eb) => eb.fn.sum<number>(eb.fn("length", ["chunk"])).as("n")).where("task_id", "=", id)))!.n;
    assert.ok(stored <= MAX_LOG_BYTES + 100, `stored ${stored}`);
  });

  test("hello stores capabilities; bad ones are refused", async () => {
    const e = await env();
    assert.equal((await call(e.key, "/worker/hello", { version: "2.1", slots: 3, capabilities: { ...CAPS, os: "plan9" } })).status, 400);
    const ok = await call(e.key, "/worker/hello", { version: "2.1", slots: 3, capabilities: CAPS });
    assert.deepEqual(await ok.json(), { envId: e.id, label: e.id, slots: 2 });
    assert.equal((await listEnvs(db)).find((x) => x.id === e.id)!.version, "2.1");
  });


  test("artifacts: only PNG, JSON, JUnit XML and UTF-8 text are accepted; the type comes from the bytes", async () => {
    await clear();
    const e = await env();
    const id = await task();
    await claim(db, e.id, 1);
    const put = (name: string, body: Buffer | string, type = "application/octet-stream") => call(e.key, `/worker/tasks/${id}/artifacts/${name}`, body, "PUT", type);
    assert.equal((await put("shot.png", PNG, "text/html")).status, 200);
    assert.equal((await put("r.json", '{"a":1}')).status, 200);
    assert.equal((await put("junit.xml", '<?xml version="1.0"?><testsuites><testsuite/></testsuites>')).status, 200);
    assert.equal((await put("page.html", "<html><script>alert(1)</script></html>", "text/html")).status, 200);
    assert.equal((await put("tool", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 3]))).status, 415);
    assert.equal((await put("bin.dat", Buffer.from([0xff, 0xfe, 0xfd, 0xfc]))).status, 415);
    assert.equal((await put("empty.txt", "")).status, 400);
    assert.equal((await put("..%2Fescape", "x")).status, 400);
    assert.equal((await put(".hidden", "x")).status, 400);
    const types = Object.fromEntries((await getTask(db, id))!.artifacts.map((a) => [a.name, a.contentType]));
    assert.deepEqual(types, { "junit.xml": "application/xml", "page.html": "text/plain", "r.json": "application/json", "shot.png": "image/png" });
    assert.equal(sniff(Buffer.from("<html>")), "text/plain");
    assert.equal(sniff(Buffer.from("{broken")), "text/plain");
  });
});

describe("dashboard API", () => {
  let base = "";
  let stop: () => Promise<void>;
  let hiddenTask = 0, openTask = 0;
  before(async () => {
    await clear();
    await db.run(db.k.deleteFrom("build_envs"));
    await addLogin(db, "cli", "boss", "operator", null);
    await addLogin(db, "cli", "viewer1", "viewer", null);
    await addLogin(db, "cli", "maint1", "maintainer", null);
    await scopeToTracked(db);
    const perms = join(dir, "perms.json");
    writeFileSync(perms, "{}");
    const s = await startServer({
      config: loadConfig({ AUTOCRAFT_DEV_AUTH: "1", AUTOCRAFT_LISTEN: "127.0.0.1:0", AUTOCRAFT_DB: join(dir, "build.db"), AUTOCRAFT_DEV_PERMS: perms }),
      db, provider: new FakeProvider(perms), routes: apiRoutes(),
    });
    base = s.url;
    stop = s.close;
    openTask = await task({ repo: "open-app" });
    hiddenTask = await task({ repo: "vault" });
  });
  after(() => stop());

  async function signedIn(login: string) {
    const jar = new Map<string, string>();
    let csrf = "";
    const send = async (path: string, init: { method?: string; body?: unknown } = {}) => {
      const r = await fetch(new URL(path, base), {
        method: init.method ?? "GET", redirect: "manual",
        headers: {
          cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), accept: "application/json", origin: new URL(base).origin,
          ...(init.body !== undefined ? { "content-type": "application/json", "x-csrf-token": csrf } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      for (const c of r.headers.getSetCookie()) {
        const [kv] = c.split(";");
        jar.set(kv!.slice(0, kv!.indexOf("=")), kv!.slice(kv!.indexOf("=") + 1));
      }
      return r;
    };
    const start = await send("/auth/signin?return_to=/");
    const auth = await send(`${start.headers.get("location")}&login=${login}`);
    await send(auth.headers.get("location")!);
    csrf = (await send("/api/me")).headers.get("x-csrf-token") ?? "";
    return { send, get: async <T>(p: string) => (await send(p)).json() as Promise<T> };
  }

  test("tasks of a repo the viewer cannot see are left out of lists and answer 404", async () => {
    const v = await signedIn("viewer1");
    assert.deepEqual((await v.get<TaskPage>("/api/tasks")).tasks.map((t) => t.id), [openTask]);
    assert.equal((await v.send(`/api/tasks/${hiddenTask}`)).status, 404);
    assert.equal((await v.send(`/api/tasks/${openTask}`)).status, 200);
    assert.equal((await v.send("/api/tasks?repo=vault")).status, 404);
    assert.deepEqual(await v.get("/api/build/summary"), { queued: 1, running: 0, slots: 0, free: 0, online: 0 });
    const o = await signedIn("boss");
    assert.deepEqual((await o.get<TaskPage>("/api/tasks")).tasks.map((t) => t.id), [hiddenTask, openTask]);
    assert.equal((await o.get<BuildTaskDetail>(`/api/tasks/${hiddenTask}`)).repo, "vault");
  });


  test("writes are for operators and audited; the key is shown once and never listed", async () => {
    const v = await signedIn("viewer1");
    assert.equal((await v.send("/api/envs", { method: "POST", body: { id: "nope", label: "x", kind: "remote", slots: 1 } })).status, 403);
    assert.equal((await v.send(`/api/tasks/${openTask}/cancel`, { method: "POST", body: {} })).status, 403);
    const o = await signedIn("boss");
    const made = await o.send("/api/envs", { method: "POST", body: { id: "sandbox", label: "Sandbox", kind: "local-sandbox", slots: 2 } });
    assert.equal(made.status, 200);
    const { env: e, key } = (await made.json()) as { env: { id: string }; key: string };
    assert.match(key, /^cwk_sandbox_/);
    assert.equal(JSON.stringify(await o.get("/api/envs")).includes(key), false);
    assert.equal(JSON.stringify(await o.get("/api/envs")).includes("key_hash"), false);
    assert.equal((await o.send("/api/envs", { method: "POST", body: { id: "sandbox", label: "x", kind: "remote", slots: 1 } })).status, 409);
    assert.equal((await o.send(`/api/envs/${e.id}`, { method: "PUT", body: { slots: 0 } })).status, 400);
    assert.equal((await o.send(`/api/envs/${e.id}`, { method: "PUT", body: { enabled: false } })).status, 200);
    // a disabled environment is hidden from viewers
    assert.deepEqual(await v.get("/api/envs"), []);
    const rot = (await (await o.send(`/api/envs/${e.id}/rotate-key`, { method: "POST", body: {} })).json()) as { key: string };
    assert.notEqual(rot.key, key);
    assert.equal(await authenticate(db, key), null);
    assert.equal((await o.send(`/api/tasks/${openTask}/cancel`, { method: "POST", body: {} })).status, 200);
    const actions = (await db.prepare("SELECT action FROM audit WHERE action LIKE 'env-%' OR action = 'task-cancel' ORDER BY rowid").all() as { action: string }[]).map((r) => r.action);
    assert.ok(["env-create", "env-change", "env-rotate-key", "task-cancel"].every((a) => actions.includes(a)), actions.join());
  });

  test("artifact downloads are attachments with nosniff and a sandbox policy; PNG is inline", async () => {
    await clear();
    const e = await env();
    const id = await task({ repo: "open-app" });
    await claim(db, e.id, 1);
    const w = await startWorkerServer({ db, listen: "127.0.0.1:0" });
    try {
      const put = (name: string, body: Buffer | string) => fetch(`${w.url}/worker/tasks/${id}/artifacts/${name}`, { method: "PUT", headers: { authorization: `Bearer ${e.key}` }, body: typeof body === "string" ? body : new Uint8Array(body) });
      assert.equal((await put("page.html", "<script>alert(1)</script>")).status, 200);
      assert.equal((await put("shot.png", PNG)).status, 200);
    } finally {
      await w.close();
    }
    const v = await signedIn("maint1");
    const html = await v.send(`/api/tasks/${id}/artifacts/page.html`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-disposition") ?? "", /^attachment; filename="page.html"; filename\*=UTF-8''page\.html$/);
    assert.match(html.headers.get("content-type") ?? "", /^text\/plain/);
    assert.equal(html.headers.get("x-content-type-options"), "nosniff");
    assert.equal(html.headers.get("content-security-policy"), "sandbox");
    assert.equal(await html.text(), "<script>alert(1)</script>");
    const png = await v.send(`/api/tasks/${id}/artifacts/shot.png`);
    assert.match(png.headers.get("content-disposition") ?? "", /^inline/);
    assert.equal(png.headers.get("content-type"), "image/png");
    assert.equal(png.headers.get("content-security-policy"), "sandbox");
    assert.equal((await v.send(`/api/tasks/${id}/artifacts/missing.txt`)).status, 404);
    assert.equal((await v.send(`/api/tasks/${id}/artifacts/..%2F..%2Fbuild.db`)).status, 404);
    const hidden = await task({ repo: "vault" });
    assert.equal((await v.send(`/api/tasks/${hidden}/artifacts/x.txt`)).status, 404);

    // A dashboard without the artifact directory fetches the bytes from the runner, after the same checks.
    const key = "k".repeat(40);
    const runner = await startWorkerServer({ db, listen: "127.0.0.1:0", internalKey: key });
    const paths: string[] = [];
    runner.server.prependListener("request", (req) => paths.push(req.url ?? ""));
    useRunnerClient({ url: runner.url, sessionKey: key });
    try {
      const got = await v.send(`/api/tasks/${id}/artifacts/page.html`);
      assert.equal(got.status, 200);
      assert.equal(got.headers.get("content-security-policy"), "sandbox");
      assert.equal(await got.text(), "<script>alert(1)</script>");
      assert.equal((await v.send(`/api/tasks/${id}/artifacts/missing.txt`)).status, 404);
      assert.equal((await v.send(`/api/tasks/${hidden}/artifacts/x.txt`)).status, 404);
      assert.deepEqual(paths, [`/internal/artifacts/${id}/page.html`], "the runner is asked only after the dashboard's checks pass");
      assert.equal((await fetch(`${runner.url}/internal/artifacts/${id}/page.html`)).status, 401, "an unsigned request");
    } finally {
      useRunnerClient(null);
      await runner.close();
    }
  });
});

describe("cancel and the worker API limiter", () => {
  test("cancelling a claimed task records the cancel; a finished task is a 409 with no audit row", async () => {
    await clear();
    const e = await env();
    const id = await task();
    await claim(db, e.id, 1);
    assert.equal((await getTask(db, id))!.state, "claimed");
    const t = await cancelTask(db, id, "op");
    assert.equal(t.state, "cancelled");
    assert.equal(t.cancelRequested, true);
    assert.equal(t.summary, "Cancelled by an operator.");
    const audits = async () => (await db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'task-cancel'").get() as { n: number }).n;
    const before = await audits();
    await assert.rejects(async () => await cancelTask(db, id, "op"), /already cancelled/);
    assert.equal(await audits(), before);
  });

  test("the failed-key limiter persists across requests: the 31st wrong key is a 429", async () => {
    const w = await startWorkerServer({ db, listen: "127.0.0.1:0" });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 31; i++) statuses.push((await fetch(`${w.url}/worker/hello`, { method: "POST", headers: { authorization: "Bearer wrong-key" } })).status);
      assert.ok(statuses.slice(0, 30).every((s) => s === 401), statuses.join());
      assert.equal(statuses[30], 429);
    } finally {
      await w.close();
    }
  });
});
