// Which merges get a post-merge review: those nobody approved, and those whose code a push of ours changed after the approval.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { landedWhy, ownPushes, type LandedApproval } from "../src/core/evidence.ts";
import type { LandedWhy } from "../src/core/plan.ts";
import { loadLandedWhy } from "../src/data/views/landed.ts";
import { recordAttempts, recordLanded } from "../src/data/merge/index.ts";
import { savePostmerge } from "../src/data/review/index.ts";
import { listWorkflows, recordEvents } from "../src/data/workflow/index.ts";
import { runPostmergeFile } from "../src/postmerge/file.ts";
import { planCtx, LANES } from "../src/runner/autopilot.ts";
import { selectPostmerge } from "../src/postmerge/select.ts";
import { insertWorkflow } from "../src/workflow/store.ts";
import { OPERATOR, world, type World } from "./world-db.ts";

let current: World | null = null;
afterEach(() => current?.close());

const day = (d: number, h = 0): string => new Date(Date.UTC(2026, 1, d, h)).toISOString();
const APPROVED: LandedApproval = { approvedAt: day(2), since: day(2), prOpenedAt: null };

test("a merge is reviewed when nobody approved it or our push changed code after the approved head", () => {
  const push = { id: 1, from: "a", to: "b", reason: null, at: day(3), state: "pushed" as const, source: null };
  const edge = (o: object) => ownPushes([], [{ ...push, kind: "fixup", ...o } as never], [], []);
  const outcome = (action: string, at = day(3)) => ownPushes([], [], [{ action, from: "a", to: "b", at }], []);
  const repin = ownPushes([], [], [], [{ from: "a", to: "b", at: day(3) }]);
  const cleanBase = edge({ kind: "conflict", state: "merged", ownDiff: "same" });
  const table: [string, LandedApproval | null, ReturnType<typeof ownPushes>, LandedWhy | null][] = [
    ["by the rule", null, [], "rule"],
    ["as approved", APPROVED, [], null],
    ["a fix-up of the review", APPROVED, edge({}), "push"],
    ["a fix-up of another source", APPROVED, edge({ source: "premerge" }), "push"],
    ["a CI fix", APPROVED, edge({ kind: "cifix" }), "push"],
    ["a resolved conflict with code changes", APPROVED, edge({ kind: "conflict", state: "merged", ownDiff: "changed" }), "push"],
    ["an implementation's revision", APPROVED, outcome("implement-push"), "push"],
    ["a clean base merge", APPROVED, cleanBase, null],
    ["an autorepin", APPROVED, repin, null],
    ["a fix-up the person saw when they approved", APPROVED, edge({ at: day(1) }), null],
    ["a fix-up the person saw when they answered later", { ...APPROVED, since: day(4) }, edge({}), null],
    ["a fix-up under a clean base merge", APPROVED, [...edge({}), ...ownPushes([], [{ ...push, kind: "conflict", from: "b", to: "c", state: "merged", ownDiff: "same" } as never], [], [])], "push"],
    ["a fix-up under someone else's commits", APPROVED, ownPushes([{ action: "fixup-push", from: "x", to: "y", at: day(3), lines: 4, landed: true }], [], [], []), "push"],
    ["a fix-up someone took back off the branch", APPROVED, ownPushes([{ action: "fixup-push", from: "a", to: "y", at: day(3), lines: 4, landed: true }], [], [], []), null],
    ["a fix-up of a commit that did not land", APPROVED, edge({ from: "x", to: "y" }), null],
    ["an implementation approved before its PR existed", { ...APPROVED, prOpenedAt: day(3) }, [], "implementation"],
    ["an implementation approved on its PR", { ...APPROVED, prOpenedAt: day(1) }, [], null],
    ["an implementation revised after the approval", { ...APPROVED, prOpenedAt: day(1) }, outcome("implement-push"), "push"],
  ];
  for (const [name, approval, pushes, why] of table) {
    const head = pushes.some((p) => p.to === "c") ? "c" : pushes.some((p) => p.to === "b") ? "b" : "a";
    assert.equal(landedWhy({ head, approval, pushes }), why, name);
  }
});

/** PRs 1-5 in a repo with its Pipeline off, each merged through its merge leg: 2 after our fix-up, 4 implementing issue 40 whose merge was approved before the PR; 5 has no leg. */
async function merged(): Promise<World> {
  let w = current = await (await world()).repo();
  for (const n of [1, 2, 3, 4, 5]) w = await w.pr(n);
  w = await w.issue(40);
  const { db } = w;
  await db.run(db.k.updateTable("settings").set({ value: day(1) }).where("key", "in", ["postmerge_since", "postmerge_unscoped_since"]));
  await db.run(db.k.updateTable("items").set({ created_at: day(3) }).where("number", "=", 4));
  await db.run(db.k.insertInto("implementations").values({ repo: "app", number: 40, queued_by: OPERATOR, state: "pr-opened", attempt: 1, text_hash: "t", pr_number: 4, created_at: day(2), updated_at: day(2) }));
  for (const n of [1, 2, 3, 4]) {
    const id = await insertWorkflow(db, { repo: "app", number: n === 4 ? 40 : n, kind: n === 4 ? "issue" : "pr", entry: n === 4 ? "implement" : "review", state: "running", startedBy: OPERATOR, startedAt: day(2), startedVia: "cli", approvedBy: OPERATOR, approvedAt: day(2), approvedVia: "cli" });
    await db.run(db.k.insertInto("preapprovals").values({ repo: "app", number: n, by: OPERATOR, at: day(4), instructions: "", state: "queued", from_head: "a", head: `sha${n}`, updated_at: day(4), workflow_id: typeof id === "number" ? id : null }));
  }
  await db.run(db.k.insertInto("fixups").values({ repo: "app", number: 2, from_head: "a", to_head: "sha2", state: "pushed", created_at: day(3), attempt: 1 }));
  await recordAttempts(db, [1, 4, 5].map((n) => ({ repo: "app", number: n, head: `sha${n}`, runId: "r", at: day(5), path: "rule", method: "squash", outcome: "merged", reason: null, ci: "success", mergeable: "MERGEABLE" })));
  // 2 and 3 land in one batch.
  await db.run(db.k.insertInto("merge_batches").values({ id: 1, repo: "app", branch: "b", state: "open", base_sha: "m", commit_sha: "t", created_at: day(5), updated_at: day(5) }));
  await recordLanded(db, { batchId: 1, runId: "r", at: day(5), mergeSha: "mm", members: [2, 3].map((n) => ({ number: n, head: `sha${n}`, path: "rule", ci: "success", mergeable: "MERGEABLE" })), by: "batch" });
  await db.run(db.k.updateTable("item_workflows").set({ state: "done" }).where("repo", "=", "app"));
  await db.run(db.k.updateTable("tracked_repos").set({ pipeline: 0 }).where("name", "=", "app"));
  return w;
}

test("each merge, batched or not, goes by its own approval and pushes, also where the Pipeline switch is off", async () => {
  const { db } = await merged();
  assert.deepEqual(Object.fromEntries(await loadLandedWhy(db, [1, 2, 3, 4, 5].map((number) => ({ repo: "app", number })))),
    { "app#1": null, "app#2": "push", "app#3": null, "app#4": "implementation", "app#5": "rule" });
  assert.deepEqual((await selectPostmerge(db, "app", Date.parse(day(6)))).map((m) => m.number), [2, 4, 5]);
  const lane = LANES.find((l) => l.name === "postmerge")!;
  assert.equal(lane.scope, "cleanup");
  assert.deepEqual((await lane.detect(db, await planCtx(db))).map((c) => c.params.repo), ["app"]);
  // The reviewed ones are done; their merges outside the scope count from the setting only.
  await savePostmerge(db, [2, 4].map((number) => ({ repo: "app", number, merge_sha: "m", at: day(6), model: "opus", run_id: "r", findings: [], error: null })));
  assert.deepEqual((await selectPostmerge(db, "app", Date.parse(day(6)))).map((m) => m.number), [5]);
  await db.run(db.k.updateTable("settings").set({ value: day(6) }).where("key", "=", "postmerge_unscoped_since"));
  assert.deepEqual(await selectPostmerge(db, "app", Date.parse(day(6))), []);
});

test("an approving answer accepts our pushes up to when its question was asked, an approval without a question up to when it was made", async () => {
  const { db } = await merged();
  const why = async () => (await loadLandedWhy(db, [{ repo: "app", number: 2 }])).get("app#2");
  const w = (await listWorkflows(db, { refs: [{ repo: "app", number: 2 }] }))[0]!;
  await db.run(db.k.updateTable("item_workflows").set({ approved_at: day(4) }).where("id", "=", w.id));
  assert.equal(await why(), null, "approved after the push");
  const answered = (seenAt: string) => recordEvents(db, [{ workflowId: w.id, repo: "app", number: 2, login: OPERATOR, kind: "answered", at: day(4), seenAt }]);
  await answered(day(2, 12));
  assert.equal(await why(), "push", "the question was asked before the push");
  await answered(day(3, 12));
  assert.equal(await why(), null, "the question was asked after it");
});

test("the defects of a review outside the scope are filed", async () => {
  const { db } = await merged();
  const defect = { severity: "defect" as const, title: "Parser drops a line", body: "The last line is dropped.", file: null, line: 1, scenario: null, duplicate_of: null };
  await savePostmerge(db, [{ repo: "app", number: 2, merge_sha: "m", at: day(6), model: "opus", run_id: "r", findings: [defect] as never, error: null }]);
  const lane = LANES.find((l) => l.name === "postmerge-file")!;
  assert.deepEqual((await lane.detect(db, await planCtx(db))).map((c) => c.params.repo), ["app"]);
  const r = await runPostmergeFile(db, { repo: "app" }, () => {}, { exec: async (_c, args) => ({ code: 0, stdout: args[1] === "create" ? "https://github.com/storytold/app/issues/100\n" : "", stderr: "" }), now: () => new Date(), fileExists: async () => true });
  assert.deepEqual(r.filed.map((x) => x.ref), ["app#2"]);
});
