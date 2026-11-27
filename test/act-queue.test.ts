// Card presses at the daily GitHub write limit: they queue instead of failing, drain in order through the Act
// step against the one shared count, and are carried out only for a presser who may still act. (The step's closes: act-closes.test.ts.)
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { runAct } from "../src/act/index.ts";
import { queuedCards } from "../src/conversations/queue.ts";
import { actUsedToday } from "../src/conversations/usage.ts";
import { doCard, liveWrite } from "../src/conversations/act.ts";
import { excluded } from "../src/db/kx.ts";
import { T1, world, type World } from "./world-db.ts";

let current: World | null = null;
afterEach(() => current?.close());

/** The world's GitHub with every item an issue, recording comments. */
const deps = (w: World, o: { posted?: string[]; permission?: string } = {}) => {
  const base = w.gh.actDeps();
  return { ...base, querier: { ...base.querier, query: async (q: string, v: object) => {
    const id = String((v as { id?: string }).id ?? "");
    if (q.includes("collaborators")) return { repository: { collaborators: { edges: [{ permission: o.permission ?? "WRITE", node: { login: String((v as { login: string }).login) } }] } } };
    if (q.includes("addComment")) { o.posted?.push(id); return { addComment: { commentEdge: { node: { url: `https://x.test/${id}` } } } }; }
    const r = await base.querier.query(q, v) as { repository?: { issueOrPullRequest?: Record<string, unknown> } };
    const x = r.repository?.issueOrPullRequest;
    if (x) { x.__typename = "Issue"; delete x.headRefOid; }
    return r;
  } } };
};

const limit = async (w: World, n: number) => await w.db.run(w.db.k.insertInto("stage_limits").values({ step: "act", per_day: n }).onConflict((oc) => oc.column("step").doUpdateSet(excluded(["per_day"]))));
const rank = async (w: World, n: number, level: number) =>
  await w.db.run(w.db.k.insertInto("item_rank").values({ repo: "app", number: n, score: level * 10000, breakdown: "{}", computed_at: T1 })
    .onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(excluded(["score", "breakdown", "computed_at"]))));
const commentCard = async (w: World, n: number) =>
  Number((await w.db.get(w.db.k.insertInto("conversation_cards").values({ turn_id: 0, repo: "app", number: n, kind: "comment", params: JSON.stringify({ kind: "comment" }), text: "Hello.", description: "comment" }).returning("id")))!.id);
const state = async (w: World, id: number) => (await w.db.get(w.db.k.selectFrom("conversation_cards").select(["state", "error"]).where("id", "=", id)))!;
const run = (w: World, d: ReturnType<typeof deps>, params: { limit?: number; onHandled?: (n: number) => void } = {}) => runAct(w.db, { repo: "app", dryRun: false, ...params }, () => {}, d);

describe("card presses at the daily limit", () => {
  test("a press with no room queues behind the earlier ones and the Act step carries it out in order, counted once", async () => {
    current = await (await (await (await (await world()).repo()).issue(1)).issue(2)).issue(3);
    const w = current;
    const posted: string[] = [];
    const d = deps(w, { posted });
    await limit(w, 1);
    assert.equal((await doCard(w.db, await commentCard(w, 1), "op", d as never)).card.state, "done");
    const b = await commentCard(w, 2), c = await commentCard(w, 3);
    await rank(w, 3, 4);
    assert.equal((await doCard(w.db, b, "op", { ...d, note: "kept" } as never)).card.state, "queued");
    assert.equal((await doCard(w.db, c, "op", d as never)).card.state, "queued");
    assert.deepEqual((await queuedCards(w.db)).map((r) => r.id), [c, b], "the higher level is first in line");
    const before = await actUsedToday(w.db);
    // No room: the Act step runs and leaves both.
    await run(w, d);
    assert.deepEqual([(await state(w, b)).state, (await state(w, c)).state], ["queued", "queued"]);
    // The limit is raised to 3: the head runs first, then the other, and the job reports no handled items for them.
    await limit(w, 3);
    posted.length = 0;
    let handled = 0;
    const s = await run(w, d, { onHandled: (n) => { handled = n; } });
    assert.deepEqual(posted, ["P3", "P2"]);
    assert.equal(s.cards, 2);
    assert.equal(handled, 0, "carried-out presses are not Act items");
    assert.equal(await actUsedToday(w.db), before + 2, "the two writes are counted once, by their audit rows, and the job adds none");
    assert.equal((await state(w, b)).state, "done");
    // The job's limit bounds the writes it spends on queued presses.
    const e = await commentCard(w, 1), f = await commentCard(w, 2);
    assert.equal((await doCard(w.db, e, "op", d as never)).card.state, "queued");
    assert.equal((await doCard(w.db, f, "op", d as never)).card.state, "queued");
    await limit(w, 10);
    await run(w, d, { limit: 1 });
    assert.deepEqual([(await state(w, e)).state, (await state(w, f)).state], ["done", "queued"]);
  });

  test("a press that cannot wait is refused with the reason, and a presser who lost access fails cleanly at the drain", async () => {
    current = await (await (await (await world()).repo()).issue(1)).issue(2);
    const w = current;
    const d = deps(w);
    await limit(w, 0);
    await w.pipeline(false);
    await assert.rejects(doCard(w.db, await commentCard(w, 1), "op", d as never), /the pipeline is off/);
    await w.pipeline(true);
    await assert.rejects(doCard(w.db, await commentCard(w, 1), "op", d as never), /the daily limit of Act is 0/);
    await limit(w, 1);
    await w.db.run(w.db.k.insertInto("access").values({ login: "op2", role: "operator" }));
    await doCard(w.db, await commentCard(w, 2), "op", d as never);
    const a = await commentCard(w, 1), b = await commentCard(w, 2);
    assert.equal((await doCard(w.db, a, "op2", d as never)).card.state, "queued");
    assert.equal((await doCard(w.db, b, "op", d as never)).card.state, "queued");
    await w.db.run(w.db.k.deleteFrom("access").where("login", "=", "op2"));
    await limit(w, 10);
    await run(w, d);
    assert.deepEqual([(await state(w, a)).state, (await state(w, b)).state], ["failed", "done"]);
    assert.match((await state(w, a)).error ?? "", /op2 no longer has write access/);
  });
});

describe("blocked repos and permission reads", () => {
  test("a queued press whose repo became blocked fails with the reason and blocks nobody", async () => {
    current = await (await (await (await world()).repo()).issue(1)).issue(2);
    const w = current;
    const d = deps(w);
    await limit(w, 1);
    await doCard(w.db, await commentCard(w, 2), "op", d as never);
    const a = await commentCard(w, 1);
    assert.equal((await doCard(w.db, a, "op", d as never)).card.state, "queued");
    await w.db.run(w.db.k.updateTable("tracked_repos").set({ pipeline: 0 }).where("name", "=", "app"));
    await limit(w, 10);
    // The blocked press holds no place: a new press runs at once instead of queueing behind it.
    assert.equal((await doCard(w.db, await commentCard(w, 2), "op", d as never)).card.state, "done");
    await run(w, d);
    assert.equal((await state(w, a)).state, "failed");
    assert.match((await state(w, a)).error ?? "", /Act cannot run for app now: the pipeline is off for app/);
  });

  test("a partial permission read is transient; only an empty list or a lower permission is no", async () => {
    const q = (r: unknown) => ({ query: async () => r }) as never;
    assert.equal(await liveWrite(q({ repository: { collaborators: null } }), "app", "op"), "transient");
    assert.equal(await liveWrite(q({ repository: null }), "app", "op"), "transient");
    assert.equal(await liveWrite(q({ repository: { collaborators: { edges: [] } } }), "app", "op"), "no");
    assert.equal(await liveWrite(q({ repository: { collaborators: { edges: [{ permission: "READ", node: { login: "op" } }] } } }), "app", "op"), "no");
    assert.equal(await liveWrite(q({ repository: { collaborators: { edges: [{ permission: "WRITE", node: { login: "op" } }] } } }), "app", "op"), "ok");
    assert.equal(await liveWrite({ query: async () => { throw new Error("network"); } } as never, "app", "op"), "transient");
  });
});
