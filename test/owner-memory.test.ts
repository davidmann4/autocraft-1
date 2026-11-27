// Owner memory: which sources become statements, which statements a review of a PR gets, and how a reply names conflicts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectStatements, commentDatabaseId, embedStatements } from "../src/memory/statements.ts";
import { relatedStatements } from "../src/memory/retrieve.ts";
import { toBlob } from "../src/embed/store.ts";
import { excluded } from "../src/db/kx.ts";
import { withNote } from "../src/github/note.ts";
import { parseOpusReply, parseStatementConflicts } from "../src/review/opus-parse.ts";
import { parsePremerge } from "../src/premerge/parse.ts";
import { loadPrFacts } from "../src/core/facts.ts";
import type { Embedder } from "../src/embed/model.ts";
import { world } from "./world-db.ts";

// Bag of words over a tiny vocabulary: texts sharing words are close.
const VOCAB = ["hyphenation", "dictionar", "library", "dependency", "canvas", "export", "language"];
const fake: Embedder = {
  id: "fake", dim: VOCAB.length,
  async embed(texts) {
    return texts.map((t) => {
      const v = new Float32Array(VOCAB.length);
      VOCAB.forEach((w, i) => { if (t.toLowerCase().includes(w)) v[i] = 1; });
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  },
};
const vec = async (t: string) => toBlob((await fake.embed([t], "item"))[0]!);

async function comment(w: Awaited<ReturnType<typeof world>>, id: string, repo: string, number: number, author: string, body: string): Promise<void> {
  await w.db.run(w.db.k.insertInto("comments").values({ repo, number, id, kind: "comment", author, created_at: "2026-03-01T00:00:00Z", body }));
}

test("statements come from operators' own words only, and a related one reaches the review of a similar PR of its repo", async () => {
  const w = await (await (await world()).repo()).pr(1);
  await w.db.run(w.db.k.insertInto("access").values([{ login: "boss", role: "operator" }, { login: "guest", role: "maintainer" }]));
  await comment(w, "c1", "craft-libs", 5, "boss", "Vendored hyphenation code and dictionaries belong in the shared library, not in the app.");
  await comment(w, "c2", "craft-libs", 6, "boss", withNote({ by: "operator", model: null }, "Hyphenation dictionary posted by the pipeline for the operator."));
  await comment(w, "c3", "craft-libs", 7, "guest", "Hyphenation dictionary vendoring is fine with me, as far as I can tell.");
  await comment(w, "c4", "craft-libs", 8, "boss", "ok");
  // A post from before the note line existed: no prefix, written by the pipeline, known only from its audit row.
  const node = (id: number) => `IC_${Buffer.concat([Buffer.from([0x93, 0x00, 0xce, 0, 0, 0, 7, 0xce]), Buffer.from(new Uint8Array(new Uint32Array([id]).buffer).reverse())]).toString("base64url")}`;
  assert.equal(commentDatabaseId(node(4321987)), "4321987");
  // The audit row is written when the post starts, before GitHub creates the comment.
  await comment(w, node(4321987), "craft-libs", 11, "boss", "Hyphenation dictionary vendoring is a library matter, see the other thread.");
  await w.db.run(w.db.k.insertInto("audit").values({ at: "2026-02-28T23:59:59Z", login: "comment-stage", action: "act-comment", target: "craft-libs#11", details: JSON.stringify({ url: "https://github.com/o/craft-libs/issues/11#issuecomment-4321987", state: "done" }) }));
  await comment(w, "PRR_x", "craft-libs", 12, "boss", "Hyphenation review text posted by the pipeline without a note line.");
  await w.db.run(w.db.k.insertInto("audit").values({ at: "2026-02-28T23:59:59Z", login: "review", action: "review-post", target: "craft-libs#12", details: JSON.stringify({ review: "PRR_x", state: "done" }) }));
  await w.db.run(w.db.k.insertInto("conversation_turns").values({ repo: "app", number: 10, kind: "operator", login: "boss", at: "2026-03-03T00:00:00Z", body: "Keep language data out of the app crates.", block: "b", status: "answered", seq: 1 }));

  assert.equal(await collectStatements(w.db), 2);
  assert.equal(await collectStatements(w.db), 0);
  const kinds = (await w.db.all(w.db.k.selectFrom("owner_statements").select("source_kind").where("ignored", "=", 0).orderBy("id"))).map((r) => r.source_kind).sort();
  assert.deepEqual(kinds, ["comment", "conversation"]);

  await embedStatements(w.db, fake);
  const pr = await vec("Add Danish hyphenation dictionary to the app");
  await w.db.run(w.db.k.insertInto("item_embeddings").values([{ repo: "craft-libs", number: 20, model: "fake", hash: "h", vec: pr, at: "t" }, { repo: "app", number: 1, model: "fake", hash: "h", vec: pr, at: "t" }])
    .onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(excluded(["model", "hash", "vec", "at"]))));
  const got = await relatedStatements(w.db, "craft-libs", 20);
  assert.deepEqual(got.map((s) => s.where), ["craft-libs#5"]);
  assert.equal(got[0]!.kind, "comment");
  // Another repo's PR on the same topic gets none of them.
  assert.deepEqual(await relatedStatements(w.db, "app", 1), []);

  // Statements on the PR itself are skipped.
  await w.db.run(w.db.k.insertInto("item_embeddings").values({ repo: "craft-libs", number: 5, model: "fake", hash: "h", vec: await vec("hyphenation dictionary"), at: "t" })
    .onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(excluded(["model", "hash", "vec", "at"]))));
  assert.deepEqual(await relatedStatements(w.db, "craft-libs", 5), []);
});

test("a reply's conflicts keep known ids once and drop the rest", () => {
  const known = [{ id: 1 }, { id: 2 }];
  assert.deepEqual(parseStatementConflicts([{ id: 2, reason: " why " }, { id: 9, reason: "unknown" }, { id: 2, reason: "again" }, { id: 1 }, "x"], known), [{ id: 2, reason: "why" }]);
  assert.deepEqual(parseStatementConflicts("nope", known), []);
  const review = { ref: "app#1", verdict: "take", sure: true, reason: "ok", fixes: [], risks: [], summary: "S.", why: "W.", conflicts: [{ id: 1, reason: "goes against it" }, { id: 7, reason: "x" }] };
  const st = [{ id: 1, where: "a#1", kind: "comment", title: "t", at: "2026-01-01", text: "x" }];
  assert.deepEqual(parseOpusReply(JSON.stringify(review), "app#1", true, new Set(), false, st)?.conflicts, [{ id: 1, reason: "goes against it" }]);
  const pm = parsePremerge(JSON.stringify({ ref: "app#1", findings: [], searched: "s", conflicts: [{ id: 1, reason: "r" }, { id: 5, reason: "r" }] }), "app#1", new Set(), st);
  assert.deepEqual(pm?.conflicts, [{ id: 1, reason: "r" }]);
});

test("facts list the statements that the Opus or the pre-merge review at the head named", async () => {
  const w = await (await (await (await (await world()).repo()).pr(1)).review(1)).premerge(1, "clean");
  const put = async (id: string, text: string) => (await w.db.get(w.db.k.insertInto("owner_statements").values({ source_kind: "comment", source_id: id, repo: "craft-libs", number: 5, item_title: "t", author: "boss", text, at: "a" }).returning("id")))!.id;
  const a = await put("c1", "Dictionaries belong in the library."), b = await put("c2", "No new crates.");
  const named = async () => (await loadPrFacts(w.db, { refs: ["app#1"] })).find((f) => f.number === 1)!.statementConflicts;
  assert.deepEqual(await named(), []);
  await w.db.run(w.db.k.updateTable("opus_reviews").set({ conflicts: JSON.stringify([{ id: a, reason: "adds a table" }, { id: 999, reason: "gone" }]) }));
  assert.deepEqual(await named(), [{ id: a, where: "craft-libs#5", text: "Dictionaries belong in the library.", reason: "adds a table" }]);
  await w.db.run(w.db.k.updateTable("premerge_reviews").set({ conflicts: JSON.stringify([{ id: b, reason: "adds a crate" }]) }));
  assert.deepEqual((await named()).map((d) => d.id), [a, b]);
});
