// Maintainer text to workflow actions: the parser and the resolver decide what runs, and anything unclear runs nothing.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parse, parseComment } from "../src/workflow/parse.ts";
import { resolve, type ItemState } from "../src/workflow/resolve.ts";
import { recommendationLine, replyLine } from "../src/workflow/status.ts";
import type { ItemWorkflow, PlanPart, Recommendation } from "../src/workflow/types.ts";

const SLUG = "autocraft-bot";

const started = (over: Partial<ItemWorkflow> = {}): ItemWorkflow => ({
  id: 1, repo: "storytold/photocraft", number: 812, kind: "pr", entry: "review", weight: 5, state: "running", step: null,
  startedBy: "mira", startedAt: "2026-11-24T09:02:00Z", startedVia: "github", baseHead: "abc",
  approvedBy: null, approvedAt: null, approvedVia: null, stoppedBy: null, stoppedAt: null,
  blocker: null, blockerParams: null, rec: null, recAt: null, recHead: null, plan: [], legacyPreapprovalId: null,
  updatedAt: "2026-11-24T09:02:00Z", ...over,
});
const part = (n: number, title: string): PlanPart => ({ n, title, source: "review", state: "planned" });
const pr = (workflow: ItemWorkflow | null = null): ItemState => ({ kind: "pr", workflow });
const run = (text: string, state: ItemState) => resolve(parse(text), state);

describe("workflow commands", () => {
  test("text that is not fully a command runs nothing and says what was understood", () => {
    const p = parse("fix-up and frobnicate");
    assert.equal(p.kind, "ambiguous");
    assert.ok(p.kind === "ambiguous" && p.understood.includes("fix-up") && p.rest.includes("frobnicate"));
    assert.equal(resolve(p, pr()).kind, "ambiguous");
    assert.equal(run("please merge it soon", pr()).kind, "ambiguous");
    assert.equal(run("weight 12, merge", pr()).kind, "ambiguous");
    assert.equal(run("review and implement", { kind: "issue", workflow: null }).kind, "ambiguous");
  });

  test("ordinary phrasing around command words reads as the command; hedged replies stay unread", () => {
    const words = (text: string) => { const p = parse(text, { slug: SLUG }); return p.kind === "commands" ? p.parts.map((x) => ("part" in x ? `${x.word} ${x.part}` : x.word)).join(",") : p.kind; };
    for (const [text, want] of [
      ["merge it", "merge"], ["please merge this", "merge"], ["ok go ahead and merge", "merge"], ["merge it please", "merge"], ["yes merge it", "merge"],
      ["LGTM, merge", "merge"], ["sounds good, merge it now", "merge"], ["fix-up and merge it", "fix-up,merge"], ["drop 2 and merge the rest", "drop 2,merge"],
      ["thanks, merge", "merge"], ["@autocraft-bot merge the PR", "merge"], ["go ahead", "yes"],
    ] as const) assert.equal(words(text), want, text);
    for (const text of ["don't merge it", "merge it but not yet", "wait", "no", "merge it later", "merge if CI is green", "hold the merge", "merge it please soon"]) assert.equal(words(text), "ambiguous", text);
    const reply = (text: string, mention?: string) => { const r = resolve(parse(text), pr()); return r.kind === "ambiguous" ? replyLine(r, undefined, mention) : ""; };
    assert.match(reply("merge it but soon", "autocraft-bot"), /couldn't read/);
    assert.match(reply("let's review sometime", "autocraft-bot"), /I read this as `review`\. Reply `@autocraft-bot yes`/);
    assert.match(reply("don't merge it"), /couldn't read.*Commands: review/);
  });

  test("combined commands and a weight word anywhere", () => {
    const p = parse("@autocraft-bot fix-up and merge, urgent", { slug: SLUG });
    assert.deepEqual(p, { kind: "commands", items: [], parts: [{ word: "fix-up" }, { word: "merge" }, { word: "weight", weight: 10 }] });
    const r = resolve(p, pr());
    assert.ok(r.kind === "run" && r.run.start === "fixup" && r.run.approve && r.run.weight === 10);
  });

  test("quoted, fenced and commented commands run nothing", () => {
    assert.equal(parseComment(`> @${SLUG} merge`, SLUG), null);
    assert.equal(parseComment(["```", `@${SLUG} merge`, "```"].join("\n"), SLUG), null);
    assert.equal(parseComment(`<!-- @${SLUG} merge -->`, SLUG), null);
    assert.equal(parseComment(`    @${SLUG} merge`, SLUG), null);
    assert.equal(parseComment(`Thanks!\n@${SLUG} merge\nLooks good.`, SLUG)?.kind, "commands");
  });

  test("a list after a colon: a bare number takes the repo before it", () => {
    const p = parseComment(`@${SLUG} merge:\nphotocraft#123\n#456 storytold/designcraft#7 8\n\nunrelated text`, SLUG);
    assert.deepEqual(p?.kind === "commands" && p.items, [
      { repo: "photocraft", number: 123 }, { repo: "photocraft", number: 456 },
      { repo: "storytold/designcraft", number: 7 }, { repo: "storytold/designcraft", number: 8 },
    ]);
    assert.equal(parse("merge: #12").kind, "ambiguous");
    assert.deepEqual((parse("merge: #12", { repo: "photocraft" }) as { items: unknown }).items, [{ repo: "photocraft", number: 12 }]);
  });

  test("items written inline, for surfaces without an item context", () => {
    const pc12 = { repo: "photocraft", number: 12 };
    assert.deepEqual(parse("merge photocraft#12"), { kind: "commands", items: [pc12], parts: [{ word: "merge" }] });
    assert.deepEqual(parse("photocraft#12 yes"), { kind: "yes", items: [pc12] });
    assert.deepEqual(parse("yes photocraft#12"), { kind: "yes", items: [pc12] });
    assert.deepEqual(parse("review photocraft#12 urgent"), { kind: "commands", items: [pc12], parts: [{ word: "review" }, { word: "weight", weight: 10 }] });
    const two = parse("fix-up and merge photocraft#12 and #14");
    assert.deepEqual(two.kind === "commands" && two.items, [pc12, { repo: "photocraft", number: 14 }]);
    assert.equal(parse("merge photocraft#12 junk").kind, "ambiguous");
    assert.equal(parse("merge #12").kind, "ambiguous");
    assert.equal(parse("merge 12", { repo: "photocraft" }).kind, "ambiguous");
    assert.deepEqual(parse("merge #12", { repo: "photocraft" }), { kind: "commands", items: [pc12], parts: [{ word: "merge" }] });
    // In an item's context a number after fix or drop is still a part of the plan, and autorepin keeps its argument.
    assert.deepEqual(parse("fix 1 and #2, drop #3", { repo: "photocraft" }), { kind: "commands", items: [], parts: [{ word: "fix", part: 1 }, { word: "fix", part: 2 }, { word: "drop", part: 3 }] });
    assert.deepEqual(parse("autorepin storytold/foo#3"), { kind: "commands", items: [], parts: [{ word: "autorepin", args: "storytold/foo#3" }] });
    assert.equal(parseComment(`> @${SLUG} merge photocraft#12`, SLUG), null);
  });

  test("drop by words must name exactly one planned part", () => {
    const wf = started({ state: "recommending", plan: [part(1, "Export dialog loses focus"), part(2, "Export dialog title typo"), part(3, "Unused import")] });
    const several = run("drop export dialog", pr(wf));
    assert.ok(several.kind === "ambiguous" && several.ambiguity.why === "part-matches-several");
    assert.equal(run("drop crash on save", pr(wf)).kind, "ambiguous");
    const one = run("drop title typo", pr(wf));
    assert.ok(one.kind === "run" && one.run.drop.includes(2) && one.run.drop.length === 1);
    const fix = run("fix 1 and 3, drop 2, then merge", pr(wf));
    assert.ok(fix.kind === "run" && fix.run.fix.join() === "1,3" && fix.run.drop.join() === "2" && fix.run.approve);
  });

  test("merge is the merge queue on an unstarted pull request and approval on a started item", () => {
    const fresh = run("merge", pr());
    assert.ok(fresh.kind === "run" && fresh.run.start === "merge" && fresh.run.approve);
    const going = run("merge", pr(started()));
    assert.ok(going.kind === "run" && going.run.start === null && going.run.approve && going.run.merges);
    assert.equal(run("merge", { kind: "issue", workflow: null }).kind, "refused");
  });

  test("yes needs an open recommendation, and a yes to one ending in a merge approves it", () => {
    assert.equal(run("yes", pr(started())).kind, "ambiguous");
    const rec: Recommendation = { text: "Fix both problems, then merge?", parts: { fix: [1, 2], drop: [] }, merges: true };
    const r = run("LGTM, thanks!", pr(started({ state: "recommending", rec, plan: [part(1, "a"), part(2, "b")] })));
    assert.ok(r.kind === "run" && r.run.approve && r.run.answers && r.run.fix.join() === "1,2");
  });

  test("a weight word alone needs a started item", () => {
    assert.equal(run("urgent", pr()).kind, "ambiguous");
    const r = run("urgent", pr(started()));
    assert.ok(r.kind === "run" && r.run.weight === 10 && !r.run.approve && r.run.start === null);
  });

  test("the recommendation line names what a bare yes runs", () => {
    const rec = (over: Partial<Recommendation>): Recommendation => ({ text: "Looks fine.", parts: { fix: [], drop: [] }, merges: false, ...over });
    assert.match(recommendationLine(rec({ merges: true }))!, /yes to merge it/);
    assert.match(recommendationLine(rec({ merges: true, parts: { fix: [1, 2], drop: [] } }))!, /yes to fix 1 and 2, then merge/);
    const noMerge = recommendationLine(rec({ parts: { fix: [1], drop: [] } }))!;
    assert.match(noMerge, /yes to fix 1; it comes back to you/);
    assert.doesNotMatch(noMerge, /merge/);
    assert.match(recommendationLine(rec({ close: true }))!, /yes to close it/);
    assert.match(recommendationLine(rec({}))!, /write what to do instead/);
    // The clause matches what the resolver runs for a bare yes.
    const r = run("yes", pr(started({ state: "recommending", rec: rec({ merges: true }) })));
    assert.ok(r.kind === "run" && r.run.merges);
  });
});
