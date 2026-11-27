import { test } from "node:test";
import assert from "node:assert/strict";
import { quickSearch } from "../src/dash/api/items.ts";
import { parseSearch } from "../src/db/search.ts";
import * as kx from "../src/db/kx.ts";
import type { Req } from "../src/dash/types.ts";
import { connectDb } from "./helpers/raw-db.ts";

test("text search finds items by a body word, a comment word and a typed prefix, and leaves out the rest", async () => {
  const db = await connectDb(":memory:");
  try {
    await db.run(db.k.insertInto("tracked_repos").values({ name: "app", pipeline: 1 }));
    const item = (number: number, title: string, body: string) => ({ repo: "app", number, kind: "issue", state: "OPEN", title, body, updated_at: "2026-01-01" });
    await db.run(db.k.insertInto("main.items").values([
      item(1, "Crash on start", "The exporter panics when the zebra layer is hidden."),
      item(2, "Slow startup", "Loading takes a long time."),
      item(3, "Layer order", "Layers swap after saving."),
      item(4, "Zebra stripes in preview", "Rendering artefacts."),
    ]));
    await db.run(db.k.insertInto("main.comments").values({ repo: "app", number: 3, id: "c1", kind: "comment", author: "x", body: "Same with the zebra layer here.", created_at: "2026-01-02" }));
    const req = (q: string) => ({ query: new URLSearchParams(q), user: { role: "operator", login: "o", canRead: async () => true } }) as unknown as Req;

    // Item numbers matching `typed` in a title, body or comment, as the Items browser's hits.
    const find = async (typed: string): Promise<number[]> => {
      const s = parseSearch(typed)!;
      const hits = db.k.selectFrom(kx.itemHits(db, s, { score: true }, "h")).select(["h.rid", "h.score"])
        .unionAll(db.k.selectFrom(kx.commentHits(db, s, { score: true, weight: 0.5 }, "c"))
          .innerJoin("main.items as it", (j) => j.onRef("it.repo", "=", "c.repo").onRef("it.number", "=", "c.number"))
          .select([kx.rowid("main.items", "it").as("rid"), "c.score"]));
      const rows = await db.all(db.k.selectFrom(hits.as("h")).innerJoin("main.items as i", (j) => j.on(kx.rowid("main.items", "i"), "=", (eb) => eb.ref("h.rid")))
        .select("i.number").distinct());
      return rows.map((r) => Number(r.number)).sort();
    };
    assert.deepEqual(await find("zebra"), [1, 3, 4]);
    assert.deepEqual(await find("zebra -preview"), [1, 3]);
    assert.deepEqual(await find("\"zebra layer\""), [1, 3]);
    assert.deepEqual(await find("stripes OR panics"), [1, 4]);
    const snip = await db.get(db.k.selectFrom(kx.itemHits(db, parseSearch("zebra")!, { snippets: { open: "[", close: "]", words: 24 } }, "h"))
      .select("h.body_snippet").where("h.rid", "=", (eb) => eb.selectFrom("main.items").select(kx.rowid("main.items").as("rid")).where("number", "=", 1)));
    assert.match(String(snip?.body_snippet), /\[zebra\]/, "the snippet marks the matched body word");
    // "zebr*" rather than "zebr": a bare word is also looked up as a login first.
    const typed = (await quickSearch(db, req("q=zebr*"))).map((h) => h.number);
    assert.ok(typed.includes(4) && typed.includes(1) && !typed.includes(2), `prefix search: ${typed}`);
    assert.equal(typed[0], 4, "a title match comes before body matches");
  } finally {
    await db.close();
  }
});
