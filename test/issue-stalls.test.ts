// Issues that need a person are asked or listed, and an issue waiting on a PR names it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideItem, TRIAGE_WAIT } from "../src/core/decide-item.ts";
import { issuesWithOpenPr, textRefs } from "../src/core/open-prs.ts";
import { itemFacts } from "./world.ts";
import { connectDb } from "./helpers/raw-db.ts";

const needsDecision = { classification: { flags: ["needs decision"] }, labels: { existing: ["bugfix", "needs decision"] } };

const queued = (state: string, o: { textChanged?: boolean } = {}) => ({ queuedBy: "op", standing: "yes" as const, featureOn: true, liveInRepo: 0,
  row: { state, attempt: 1, textChanged: o.textChanged ?? false, newCommentAfterQuestion: false, decisionAnswered: false, requeuedAfterEnd: false, asked: null, prOpen: false } });

test("a stuck or ended implementation waits on a person", () => {
  for (const [s, wait] of [["stuck", "a maintainer's answer on the stuck implementation"], ["failed", "a person to queue the implementation again"]]) {
    const p = decideItem(itemFacts({ implement: queued(s!) }));
    assert.equal(p.wait, wait);
    assert.equal(p.waitKind, "person");
  }
});

test("an ended implementation whose issue text changed is started again, not waited on", () => {
  const p = decideItem(itemFacts({ implement: queued("failed", { textChanged: true }) }));
  assert.deepEqual(p.actions.map((a) => [a.kind, a.params?.bucket]), [["implement", "plan"]]);
  assert.equal(p.wait, null);
});

test("an issue whose fix PR is open waits on that PR (system)", () => {
  const p = decideItem(itemFacts({ openPr: { number: 84, closes: true } }));
  assert.equal(p.wait, "open PR #84");
  assert.equal(p.waitKind, "system");
});

test("an open PR that closes the issue holds it whatever its implementation state; one that only mentions it does not", () => {
  const stopped = decideItem(itemFacts({ openPr: { number: 9, closes: true }, implement: queued("failed") }));
  assert.match(stopped.wait!, /^open PR #9, which closes it/);
  const mention = decideItem(itemFacts({ openPr: { number: 9, closes: false } }));
  assert.equal(mention.wait, TRIAGE_WAIT);
});

test("only closing references, and a person's bare mention, hold an issue; links and bot mentions do not", async () => {
  const db = await connectDb(":memory:");
  const add = async (number: number, author: string, title: string, body: string, closing_issues: string | null) =>
    await db.run(db.k.insertInto("items").values({ repo: "app", number, kind: "pr", state: "OPEN", author, title, body, closing_issues }));
  await add(10, "dev", "Rework (#1)", "See also #2. Fixes #3", null);
  await add(11, "dev", "Other", "Addresses item 3/5 of #6. Resolves: #4", "[5]");
  await add(12, "dependabot[bot]", "Bump x", 'Notes: <a href="https://github.com/o/r/issues/710">#710</a> and #711 and [#712](https://x/y)', null);
  await add(13, "dev", "Link", "https://github.com/o/r/issues/20 and [#21](https://x/21)", null);
  const m = await issuesWithOpenPr(db, "app");
  assert.deepEqual([...m].sort((a, b) => a[0] - b[0]).map(([n, p]) => [n, p.number, p.closes]),
    [[1, 10, false], [2, 10, false], [3, 10, true], [4, 11, true], [5, 11, true], [6, 11, false]]);
  // The references sync stores give the same answer as the text.
  for (const r of await db.all(db.k.selectFrom("items").select(["number", "title", "body"])))
    await db.run(db.k.updateTable("items").set({ text_refs: textRefs(r.title, r.body) }).where("number", "=", r.number));
  assert.deepEqual(await issuesWithOpenPr(db, "app"), m);
});
