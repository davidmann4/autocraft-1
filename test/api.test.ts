// The JSON API through HTTP with the fake OAuth provider: sign-in, the item and search reads, and CSRF.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Item, Progress, SearchHit, User } from "../web/src/api/types.ts";
import { addLogin } from "../src/access.ts";
import { excluded } from "../src/db/kx.ts";
import { scopeToTracked } from "../src/repos.ts";
import { apiRoutes } from "../src/dash/api/index.ts";
import { loadConfig } from "../src/dash/server/config.ts";
import { startServer } from "../src/dash/server/index.ts";
import { FakeProvider } from "../src/dash/server/provider.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "api-test-"));
const dbFile = join(dir, "dash.db");
const permsFile = join(dir, "perms.json");
writeFileSync(permsFile, JSON.stringify({ boss: { photocraft: "admin" }, maint: { photocraft: "write" } }));

const db = await connectDb(dbFile);
let base = "";
let close: () => Promise<void>;

before(async () => {
  const now = new Date().toISOString();
  const ins = (repo: string, number: number, kind: string, state: string, title: string, body: string, author: string, created_at: string, updated_at: string, closing_issues: string | null) =>
    db.run(db.k.insertInto("items").values({ repo, number, kind, state, title, body, author, created_at, updated_at, closing_issues }));
  await ins("photocraft", 1, "pr", "OPEN", "Add wave filter", "<script>x</script> body", "alice", now, now, "[5]");
  await ins("photocraft", 2, "pr", "OPEN", "Add ripple filter", "b", "bob", now, now, null);
  await ins("filmcraft", 3, "pr", "OPEN", "Fix audio drift", "c", "carol", now, now, null);
  await ins("photocraft", 4, "issue", "OPEN", "Crash on save", "d", "dave", now, now, null);
  await ins("photocraft", 5, "issue", "OPEN", "Wave filter missing", "e", "erin", now, now, null);
  await ins("untracked-repo", 6, "pr", "OPEN", "Add wave filter elsewhere", "f", "frank", now, now, null);
  await db.run(db.k.updateTable("items").set({ additions: 40, deletions: 3, changed_files: 7 }).where("repo", "=", "photocraft").where("number", "=", 1));
  await db.run(db.k.insertInto("comments").values({ repo: "photocraft", number: 1, id: "c1", kind: "comment", author: "alice", created_at: now, body: "looks good" }));
  await db.prepare("INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, want, reason) VALUES ('photocraft', 1, 'haiku', 'r1', ?, 'small extra', 'yes', 'adds a filter')").run(now);
  await db.run(db.k.insertInto("repos").values([{ name: "photocraft", visibility: "public" }, { name: "filmcraft", visibility: "public" }])
    .onConflict((oc) => oc.column("name").doUpdateSet(excluded(["visibility"]))));
  await addLogin(db, "cli", "boss", "operator", null);
  await addLogin(db, "cli", "viewer1", "viewer", null);
  await addLogin(db, "cli", "maint", "maintainer", null);
  await addLogin(db, "cli", "chatty", "maintainer", null);
  await addLogin(db, "cli", "pal", "maintainer", null);
  await scopeToTracked(db);
  const config = loadConfig({ AUTOCRAFT_DEV_AUTH: "1", AUTOCRAFT_LISTEN: "127.0.0.1:0", AUTOCRAFT_DB: dbFile, AUTOCRAFT_DEV_PERMS: permsFile });
  const s = await startServer({ config, db, provider: new FakeProvider(permsFile), routes: apiRoutes() });
  base = s.url;
  close = s.close;
});
after(async () => {
  await close();
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

class Client {
  jar = new Map<string, string>();
  csrf = "";
  async req(method: string, path: string, opts: { body?: unknown; csrf?: string | null; headers?: Record<string, string> } = {}): Promise<Response> {
    const headers: Record<string, string> = { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "), accept: "application/json", ...opts.headers };
    const csrf = opts.csrf === undefined ? this.csrf : opts.csrf;
    if (method === "POST" && csrf !== null) headers["x-csrf-token"] = csrf;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const r = await fetch(new URL(path, base), { method, headers, body, redirect: "manual" });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const k = kv!.slice(0, kv!.indexOf("=")), v = kv!.slice(kv!.indexOf("=") + 1);
      if (/Max-Age=0/.test(c)) this.jar.delete(k);
      else this.jar.set(k, v);
    }
    return r;
  }
  async json<T>(method: string, path: string, body?: unknown, status = 200): Promise<T> {
    const r = await this.req(method, path, { body });
    const text = await r.text();
    assert.equal(r.status, status, `${method} ${path}: ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }
  get = <T>(path: string) => this.json<T>("GET", path);
  post = <T>(path: string, body?: unknown, status = 200) => this.json<T>("POST", path, body, status);
}

async function signedIn(login: string): Promise<Client> {
  const c = new Client();
  const start = await c.req("GET", "/auth/signin?return_to=/");
  const auth = await c.req("GET", `${start.headers.get("location")}&login=${login}`);
  const done = await c.req("GET", auth.headers.get("location")!);
  assert.equal(done.status, 303, `sign-in of ${login}`);
  const me = await c.req("GET", "/api/me");
  c.csrf = me.headers.get("x-csrf-token") ?? "";
  assert.ok(c.csrf);
  return c;
}

describe("api", () => {
  test("without a session every endpoint answers 401 JSON", async () => {
    const c = new Client();
    const r = await c.req("GET", "/api/me");
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: "sign-in required" });
    for (const path of ["/api/classifiers", "/api/classifiers/disagreements", "/api/cost", "/api/items/photocraft/1", "/api/search?q=wave"]) assert.equal((await c.req("GET", path)).status, 401, path);
    assert.equal((await c.req("POST", "/api/commands", { body: { text: "review" }, csrf: "x" })).status, 401);
  });

  test("the live board answers JSON on its own path while /api/live streams events", async () => {
    const boss = await signedIn("boss");
    const board = await boss.req("GET", "/api/live-board");
    assert.equal(board.status, 200);
    assert.match(board.headers.get("content-type") ?? "", /application\/json/);
    assert.ok(Array.isArray((await board.json() as { lanes: unknown[] }).lanes));
    const ctl = new AbortController();
    const stream = await fetch(new URL("/api/live", base), { headers: { cookie: [...boss.jar].map(([k, v]) => `${k}=${v}`).join("; "), accept: "text/event-stream" }, signal: ctl.signal });
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
    ctl.abort();
  });

  test("me and reads: role, write repos, item, search and progress", async () => {
    const boss = await signedIn("boss");
    const me = await boss.get<User>("/api/me");
    assert.equal(me.role, "operator");
    assert.deepEqual(me.writeRepos, ["photocraft"]);
    assert.equal((await (await signedIn("maint")).get<User>("/api/me")).role, "maintainer");
    const it = await boss.get<Item>("/api/items/photocraft/1");
    assert.equal(it.body, "<script>x</script> body");
    assert.deepEqual([it.changedFiles, it.additions, it.deletions], [7, 40, 3]);
    assert.equal((await boss.get<Item>("/api/items/photocraft/4")).changedFiles, null);
    assert.deepEqual([it.verification, it.fixups], [null, []]);
    assert.equal(it.pipelineOn, false);
    await db.run(db.k.updateTable("main.items").set({ head_oid: "h1" }).where("repo", "=", "photocraft").where("number", "=", 1));
    await db.run(db.k.insertInto("verifications").values({
      repo: "photocraft", number: 1, head_sha: "h1", kind: "tests", reason: "why", plan: '{"kind":"tests","crates":["codecs"],"tests":["png::"]}', state: "failed", summary: "test failed", created_at: "2026-01-01T00:00:00Z",
    }));
    await db.run(db.k.insertInto("fixups").values({ repo: "photocraft", number: 1, from_head: "h0", state: "refused", reason: "no", files: '["a.rs"]', attempt: 1, created_at: "2026-01-01T00:00:00Z" }));
    const worked = await boss.get<Item>("/api/items/photocraft/1");
    assert.deepEqual([worked.verification?.state, worked.verification?.current, worked.verification?.plan], ["failed", true, { crates: ["codecs"], tests: ["png::"], testLines: null }]);
    assert.deepEqual([worked.fixups[0]?.files, worked.fixups[0]?.state], [["a.rs"], "refused"]);
    assert.deepEqual(worked.premerge, []);
    const finding = { severity: "defect", file: "a.rs", line: 3, title: "t", scenario: "s", fix: { file: "a.rs", change: "c" } };
    await db.run(db.k.insertInto("premerge_reviews").values({ repo: "photocraft", number: 1, head_oid: "h0", at: "2026-01-01T00:00:00Z", model: "m", findings: JSON.stringify([finding]), searched: "looked", tries: 0 }));
    await db.run(db.k.insertInto("premerge_reviews").values({ repo: "photocraft", number: 1, head_oid: "h1", at: "2026-01-02T00:00:00Z", error: "no JSON", tries: 2 }));
    const pre = (await boss.get<Item>("/api/items/photocraft/1")).premerge!;
    assert.deepEqual(pre.map((r) => [r.head, r.error, r.tries, r.findings.length]), [["h1", "no JSON", 2, 0], ["h0", null, 0, 1]]);
    assert.deepEqual(pre[1]!.findings[0], finding);
    assert.deepEqual(it.comments.map((c) => c.body), ["looks good"]);
    assert.deepEqual(it.related.map((r) => [r.number, r.relation]), [[5, "fixes"]]);
    assert.equal(it.classifications[0]!.typeLabel, "small extra");
    assert.equal((await boss.req("GET", "/api/items/untracked-repo/6")).status, 404);
    const byRef = await boss.get<SearchHit[]>("/api/search?q=photocraft%231");
    assert.deepEqual(byRef.map((h) => h.number), [1]);
    const byWords = await boss.get<SearchHit[]>("/api/search?q=wave%20filter");
    assert.deepEqual(byWords.map((h) => `${h.repo}#${h.number}`).sort(), ["photocraft#1", "photocraft#5"]);
    const p = await boss.get<Progress>("/api/progress");
    assert.equal(p.funnel.open, 5);
    assert.equal(p.perHour.length, 24);
  });


  test("a POST without the CSRF header, or from another origin, is refused", async () => {
    const pal = await signedIn("pal");
    const refused: { csrf?: string | null; headers?: Record<string, string> }[] = [
      { csrf: null }, { csrf: "wrong" }, { headers: { origin: "https://evil.example" } }, { headers: { "sec-fetch-site": "cross-site" } },
    ];
    for (const opts of refused) {
      const r = await pal.req("POST", "/api/commands", { body: { text: "x" }, ...opts });
      assert.equal(r.status, 403, JSON.stringify(opts));
      assert.match(r.headers.get("content-type") ?? "", /application\/json/);
    }
    const same = await pal.req("POST", "/api/commands", { body: { text: "same origin" }, headers: { origin: base } });
    assert.equal(same.status, 200);
  });
});
