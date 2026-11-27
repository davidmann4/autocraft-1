// The Items browser's query: qualifiers combine, negation and sort apply, pages of one order never overlap, and hits by meaning keep their order.
import assert from "node:assert/strict";
import { test } from "node:test";
import { connectDb } from "./helpers/raw-db.ts";
import { forReader, parseItemQuery, PRESETS } from "../src/core/item-query.ts";
import { countPresets, loadBrowsePage, loadFacets } from "../src/data/views/items-browse.ts";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const at = (h: number) => new Date(NOW - h * 3600_000).toISOString();

test("label, Discord and sort qualifiers combine, negation and paging hold, presets count", async () => {
  const db = await connectDb(":memory:");
  try {
    const item = (repo: string, number: number, o: Record<string, unknown> = {}) => ({
      repo, number, kind: "issue", state: "OPEN", title: `t${number}`, author: "ann", author_association: "MEMBER", labels: "[]", comments_count: 0, created_at: at(number), updated_at: at(number), ...o,
    });
    await db.run(db.k.insertInto("main.items").values([
      item("app", 1, { labels: '["Bug","ui"]', comments_count: 9 }),
      item("app", 2, { labels: '["bug"]', comments_count: 2, author: "eve", author_association: "NONE" }),
      item("app", 3, { labels: '["bug"]', comments_count: 5 }),
      item("app", 4, { labels: '["docs"]' }),
      item("app", 5, { kind: "pr", closing_issues: "[3]", labels: '["bug"]', ci_state: "SUCCESS" }),
      item("app", 6, { state: "CLOSED", labels: '["bug"]' }),
      item("other", 1, { labels: '["bug"]' }),
      ...Array.from({ length: 12 }, (_, n) => item("app", 100 + n, { updated_at: at(1) })),
    ]));
    const mention = (number: number, msg: string) => ({ msg_hash: msg, channel_hash: "c", repo: "app", number, sealed: "x" });
    await db.run(db.k.insertInto("main.discord_mentions").values([mention(1, "m1"), mention(3, "m2"), mention(3, "m3"), mention(4, "m4")]));
    const scope = { repos: ["app"], hidden: Object.assign(["other"], { visible: ["app"] }), staff: false, login: "ann" };
    const page = async (q: string, offset = 0, limit = 50) => (await loadBrowsePage(db, scope, parseItemQuery(q), { offset, limit, normalWeight: 5 }));
    const numbers = async (q: string, offset = 0, limit = 50) => (await page(q, offset, limit)).rows.map((r) => Number(r.number));

    // Labels match without case; Discord narrows to mentioned items; the most mentioned comes first; the other repo stays out.
    assert.deepEqual(await numbers("is:open label:bug discord:mentioned sort:discord"), [3, 1]);
    assert.deepEqual(await numbers("is:open label:bug -discord:mentioned sort:comments"), [2, 5]);
    assert.deepEqual(await numbers("is:issue is:open label:bug no:pr sort:comments"), [1, 2]);
    assert.deepEqual(await numbers("is:open is:outside no:response"), [2]);
    const pr = (await page("is:pr")).rows[0]!;
    assert.equal(Number(pr.linked), 3);
    assert.equal(pr.ci_state, "SUCCESS");

    // Twelve items share one update time: pages of five cover them all, each once.
    const q = "is:open sort:updated";
    const all = await numbers(q);
    const paged = [...await numbers(q, 0, 5), ...await numbers(q, 5, 5), ...await numbers(q, 10, 5), ...await numbers(q, 15, 5)];
    assert.deepEqual(paged, all);
    assert.equal(new Set(paged).size, paged.length);
    assert.equal((await page(q, 0, 5)).total, all.length);

    // Hits of a search by meaning keep their order; qualifiers still filter them.
    const hits = await loadBrowsePage(db, scope, parseItemQuery("is:open"), { offset: 0, limit: 50, normalWeight: 5, refs: ["app#4", "app#6", "app#2", "other#1"] });
    assert.deepEqual(hits.rows.map((r) => Number(r.number)), [4, 2]);

    const counts = await countPresets(db, scope, PRESETS.map((p) => ({ id: p.id, query: parseItemQuery(p.query) })));
    assert.equal(counts.open, all.length);
    assert.equal(counts.discord, 3);
    assert.equal(counts.outside, 1);
    const facets = await loadFacets(db, scope);
    assert.equal(facets.labels[0], "bug");
    assert.ok(facets.authors.includes("eve"));

    // A row only the automatic merge rule started asks nobody: it is stopped, not waiting on a person.
    const wf = (number: number, startedBy: string) => ({ repo: "app", number, kind: "issue", entry: "review", state: "recommending", started_by: startedBy, started_at: at(1), started_via: "github", updated_at: at(1) });
    await db.run(db.k.insertInto("main.item_workflows").values([wf(2, "automatic merge rule"), wf(3, "ann")] as never));
    assert.deepEqual(await numbers("autocraft:waiting"), [3]);
    assert.deepEqual(await numbers("autocraft:stopped"), [2]);
  } finally {
    await db.close?.();
  }
});

test("viewers cannot filter by review verdict or staff-only flags: those terms are reported as not applied", () => {
  const viewer = forReader(parseItemQuery("is:open review:clean -is:security"), false);
  assert.deepEqual(viewer.terms.map((x) => x.key), ["state"]);
  assert.deepEqual(viewer.unknown, ["review:clean", "-is:security"]);
  assert.equal(forReader(parseItemQuery("review:clean"), true).terms.length, 1, "staff keep the filter");
});
