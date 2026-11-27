// What the web sends and asks for, against the routes that answer: a control's body as the web writes it, the ids its feeds carry.
import assert from "node:assert/strict";
import { test } from "node:test";
import { insertRun } from "../src/agents/runs.ts";
import { apiRoutes } from "../src/dash/api/index.ts";
import type { Req } from "../src/dash/types.ts";
import { historyRows } from "../web/src/lib/history.ts";
import type { ActivityPage, ItemTrace, ItemTraceDetail, MaintainItem, MaintainItems } from "../web/src/api/types.ts";
import { connectDb, type Db } from "./helpers/raw-db.ts";

const T = (n: number) => `2026-01-01T00:${String(n).padStart(2, "0")}:00Z`;
const H = "a".repeat(40);

/** The answer of the route the method and path reach. */
async function call<A>(db: Db, method: "GET" | "POST", url: string, json?: unknown): Promise<A> {
  const { pathname, searchParams } = new URL(url, "http://x");
  for (const r of apiRoutes()) {
    const names = [...r.pattern.matchAll(/:(\w+)/g)].map((m) => m[1]!);
    const m = r.method === method ? new RegExp(`^${r.pattern.replace(/:\w+/g, "([^/]+)")}$`).exec(pathname) : null;
    if (!m) continue;
    const req: Req = {
      method, path: pathname, params: Object.fromEntries(names.map((k, i) => [k, decodeURIComponent(m[i + 1]!)])), query: searchParams, form: new URLSearchParams(), json, csrf: "", nonce: "",
      user: { login: "op", role: "operator", canWrite: async () => true, canRead: async () => true },
    };
    return (await (await r.handler(db, req))).json as A;
  }
  throw new Error(`no route ${method} ${pathname}`);
}

async function fresh(): Promise<Db> {
  const db = await connectDb(":memory:");
  await db.run(db.k.insertInto("repos").values({ name: "app", visibility: "public" }));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", pipeline: 1 }).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("settings").values({ key: "github_identity", value: "app" }).onConflict((oc) => oc.column("key").doUpdateSet({ value: "app" })));
  await db.run(db.k.insertInto("access").values({ login: "op", role: "operator" }).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("items").values({ repo: "app", number: 7, kind: "pr", state: "OPEN", title: "Item", author: "dev", head_oid: H, created_at: T(0), updated_at: T(0) }));
  return db;
}

test("the Work queue's Hold and Resume: the held item is listed until it is resumed", async () => {
  const db = await fresh();
  const held = async () => (await call<{ held: { repo: string; number: number; line: string }[] }>(db, "GET", "/api/maintain/queue")).held;
  const press = async (text: string) => call<{ items: { outcome: string }[]; lines: string[] }>(db, "POST", "/api/items/app/7/command", { text });
  const on = await press("hold");
  assert.equal(on.items[0]!.outcome, "run", on.lines.join(" "));
  assert.deepEqual((await held()).map((h) => `${h.repo}#${h.number}`), ["app#7"]);
  assert.match((await held())[0]!.line, /Held by op/);
  const off = await press("resume");
  assert.equal(off.items[0]!.outcome, "run", off.lines.join(" "));
  assert.deepEqual(await held(), []);
});

test("every event of the activity feed opens from its item's trace as the same event", async () => {
  const db = await fresh();
  const { k } = db;
  // Another item's rows first, so a row's id is not its position in the item.
  for (const n of [8, 7]) {
    await db.run(k.insertInto("plan_history").values([0, 1].map((i) => ({ repo: "app", number: n, head: H, old_state: "reviewing", new_state: `state-${i}`, wait: null, reasons: "[]", at: T(1 + i) }))));
    await db.run(k.insertInto("stages").values({ repo: "app", number: n, stage: "classified", at: T(3), actor: "classify" }));
    for (const step of ["review", "verify"]) {
      const job = (await db.get(k.insertInto("jobs").values({ step, params: "{}", requested_by: "pipeline", requested_at: T(4), state: "done", started_at: T(4), ended_at: T(5) }).returning("id")))!.id;
      await db.run(k.insertInto("job_items").values([{ job_id: job, repo: "app", number: 99, at: T(4) }, { job_id: job, repo: "app", number: n, outcome: `${step} of #${n}`, at: T(5) }]));
    }
    await insertRun(db, { jobId: null, step: "opus-review", stage: 5, promptId: "p", promptVersion: "1", provider: "claude", model: "opus", items: [{ repo: "app", number: n }], prompt: "p" });
    await db.run(k.insertInto("opus_review_history").values([{ verdict: "take", sure: null }, { verdict: null, sure: 0 }].map((r, i) => ({ repo: "app", number: n, head_oid: H, at: T(6 + i), model: "opus", mode: "full", reason: "", ...r }))));
    await db.run(k.insertInto("premerge_reviews").values({ repo: "app", number: n, head_oid: H, at: T(8), model: "opus", findings: "[]" }));
    await db.run(k.insertInto("fixups").values({ repo: "app", number: n, from_head: H, state: "pushed", attempt: 1, files: "[]", created_at: T(9) }));
    await db.run(k.insertInto("merges").values({ repo: "app", number: n, head_oid: H, at: T(10), run_id: "r", path: "rule", outcome: "refused", reason: "red" }));
    await db.run(k.insertInto("push_outcomes").values({ repo: "app", number: n, at: T(11), stage: "fixup", action: "fixup-push", to_oid: H, before_res: "green" }));
    await db.run(k.insertInto("workflow_events").values({ repo: "app", number: n, login: "op", via: "dashboard", kind: "answered", line: "Merging.", at: T(12) }));
    await db.run(k.insertInto("audit").values({ at: T(13), login: "bot", action: "review-post", target: `app#${n}`, details: "{}" }));
  }
  const kinds = "job,plan,model-call,check,review,decision,step,write";
  const feed = (await call<ActivityPage>(db, "GET", `/api/activity?limit=200&kinds=${kinds}`)).events.filter((e) => e.item.number === 7);
  for (const id of ["job:", "plan:", "stage:", "review:opus:", "review:premerge:", "fixup:", "merge:", "push:", "workflow:", "audit:", "run:"]) assert.ok(feed.some((e) => e.id.startsWith(id)), `the feed has ${id}`);
  for (const e of feed) {
    const d = await call<ItemTraceDetail>(db, "GET", `/api/items/app/7/trace/event?id=${encodeURIComponent(e.id)}`);
    assert.deepEqual([d.id, d.kind, d.at, d.summary], [e.id, e.kind, e.at, e.summary]);
  }
});

test("an item's History shows a command once, and an archived answer as its author's", async () => {
  const db = await fresh();
  await db.run(db.k.insertInto("workflow_events").values([
    { repo: "app", number: 7, login: "ochre", via: "cli", kind: "archived", parsed: JSON.stringify({ kind: "archived", legacy: "decision:app#7:merge" }), line: "Merge it? Answer: Merge.", at: T(1) },
    { repo: "app", number: 7, login: "pipeline", via: "cli", kind: "archived", parsed: JSON.stringify({ kind: "archived", legacy: "open:Scope?" }), line: "Scope? Withdrawn at the switch to the maintainer workflow.", at: T(2) },
    { repo: "app", number: 7, login: "op", via: "github", kind: "started", line: "Reviewing.", at: T(3) },
  ]));
  const { events: said } = await call<MaintainItem>(db, "GET", "/api/maintain/items/app/7");
  const { events } = await call<ItemTrace>(db, "GET", "/api/items/app/7/trace?kinds=decision");
  const rows = historyRows(said, events);
  assert.deepEqual(rows.map((r) => (r.t === "said" ? `${r.e.login}: ${r.e.line}` : `${r.e.actor.type} ${r.e.actor.name}: ${r.e.summary}`)), [
    "person ochre: Merge it? Answer: Merge.", "step Decide: Scope? Withdrawn at the switch to the maintainer workflow.", "op: Reviewing.",
  ]);
});

test("the list of merged pull requests is AutoCraft's merges, newest merge first, however late the items changed", async () => {
  const db = await fresh();
  const merged = async (number: number, at: string, o: { path?: string; batch?: boolean; ours?: boolean } = {}) => {
    await db.run(db.k.insertInto("items").values({ repo: "app", number, kind: "pr", state: "MERGED", title: `PR ${number}`, author: "dev", head_oid: H, created_at: T(0), merged_at: at, closed_at: at, updated_at: T(59 - number) }));
    if (o.path) await db.run(db.k.insertInto("merges").values({ repo: "app", number, head_oid: H, at, run_id: "r", path: o.path, outcome: "merged" }));
    if (o.batch) {
      const id = (await db.get(db.k.insertInto("merge_batches").values({ repo: "app", branch: `b${number}`, base_sha: "b", commit_sha: "c", state: "merged", created_at: at, updated_at: at }).returning("id")))!.id;
      await db.run(db.k.insertInto("merge_batch_prs").values({ batch_id: id, repo: "app", number, head_oid: H, position: 1 }));
    }
  };
  await merged(10, T(20), { path: "rule" });
  await merged(11, T(30), { path: "maintainer" });
  await merged(12, T(25), { batch: true });
  await merged(13, T(40));
  const list = await call<MaintainItems>(db, "GET", "/api/maintain/items?show=merged&limit=2");
  assert.deepEqual(list.rows.map((r) => [r.number, r.merged?.how, r.merged?.at]), [[11, "approval", T(30)], [12, "batch", T(25)]]);
  assert.equal(list.counts.done, 3);
  assert.deepEqual((await call<MaintainItems>(db, "GET", "/api/maintain/items?show=merged")).rows.map((r) => r.number), [11, 12, 10]);
});
