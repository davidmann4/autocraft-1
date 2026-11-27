// The guard: a write passes only when the Plan, reloaded right before it, still holds the same action at the same head.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setPushApproval } from "../src/fixup/approval.ts";
import { gates } from "../src/core/gates.ts";
import { setCommentApproval } from "../src/act/approval.ts";
import { guard, guardBatchMerge, guardItem, guardRepo, type Live, type LiveRead } from "../src/core/guard.ts";
import { slugOf } from "../src/owners.ts";
import { closeItem, mergeViaCommand } from "../src/github/write.ts";
import { G } from "./guarded.ts";
import { parseSafeMergeArgs, safeMerge } from "../src/merge/safe-merge.ts";
import { insertWorkflow } from "../src/workflow/store.ts";
import { world } from "./world-db.ts";
import { prFacts } from "./world.ts";
import type { Db } from "./helpers/raw-db.ts";

const ref = { repo: "app", number: 1 };
const open: LiveRead = { state: "OPEN", head: "sha1", draft: false, mergeable: "MERGEABLE" };
const live = (r: Partial<LiveRead> = {}): Live => async () => ({ ...open, ...r });
/** PR 1 in the state a clean take is merged from. */
const fresh = async (_prs: { n: number }[]) => (await (await (await (await (await (await (await world()).repo(["comment"])).pr(1)).review(1)).verified(1)).premerge(1, "clean")).pipeline(false)).db;
const MERGE = { kind: "merge", head: "sha1" } as const;
const T = "2026-01-02T00:00:00Z";
const OP = { operator: "op" };

const ok = (r: unknown): boolean => !(r as { refused?: string }).refused;
const why = (r: unknown): string => (r as { refused?: string }).refused ?? "";

/** PR 1 as a take-fix review with one fix, pushable, in a repo approved for pushes. */
async function takeFix(): Promise<Db> {
  const db = await fresh([{ n: 1 }]);
  await db.run(db.k.updateTable("opus_reviews").set({ verdict: "take-fix", fixes: JSON.stringify([{ file: "src/lib.rs", change: "rename a to b" }]) }));
  await setPushApproval(db, "op", "app", true);
  return db;
}

test("passes when the Plan still holds the merge at the reviewed head", async () => {
  const g = await guard(await fresh([{ n: 1 }]), ref, MERGE, OP, live());
  assert.ok(ok(g), why(g));
  assert.deepEqual([(g as { head: string }).head, (g as { repo: string }).repo, (g as { number: number }).number], ["sha1", "app", 1]);
});

test("refuses a merge without a live read, and when GitHub's head moved", async () => {
  const db = await fresh([{ n: 1 }]);
  assert.match(why(await guard(db, ref, MERGE, OP)), /no live read/);
  assert.match(why(await guard(db, ref, MERGE, OP, live({ head: "sha9" }))), /head moved from sha1 to sha9/);
  assert.match(why(await guard(db, ref, MERGE, OP, live({ state: "CLOSED" }))), /no longer open/);
});

test("refuses when the PR's workflow ended in the backlog", async () => {
  const db = await fresh([{ n: 1 }]);
  await insertWorkflow(db, { repo: "app", number: 1, kind: "pr", entry: "review", state: "backlog", startedBy: "op", startedAt: T, startedVia: "dashboard" });
  assert.match(why(await guard(db, ref, MERGE, OP, live())), /sent this to the backlog/);
});

test("refuses when a maintainer's changes-requested review blocks the PR", async () => {
  const db = await fresh([{ n: 1 }]);
  await db.prepare("INSERT INTO review_gates (repo, number, blocked, by_login, read_at) VALUES ('app', 1, 1, 'maint', ?)").run(T);
  assert.match(why(await guard(db, ref, MERGE, OP, live())), /plan no longer has merge/);
});

test("a push needs the repo's push approval at the write", async () => {
  const db = await takeFix();
  const push = { kind: "fixup", bucket: "fix", head: "sha1" } as const;
  assert.ok(ok(await guard(db, ref, push, OP, live())), "holds while approved");
  await setPushApproval(db, "op", "app", false);
  assert.match(why(await guard(db, ref, push, OP, live())), /Pushes in app are not approved/);
});

test("the global pipeline switch gates the pipeline's writes, not an operator's", async () => {
  const db = await fresh([{ n: 1 }]);
  assert.match(why(await guard(db, ref, MERGE, "pipeline", live())), /pipeline is off/i);
  assert.ok(ok(await guard(db, ref, MERGE, OP, live())));
  await db.run(db.k.updateTable("main.settings").set({ value: "1" }).where("key", "=", "pipeline_enabled"));
  assert.ok(ok(await guard(db, ref, MERGE, "pipeline", live())));
});

test("gates: each action kind needs its approval", () => {
  const off = (k: "commentApproved" | "ciApproved") => prFacts({ repoFacts: { [k]: false } });
  const unstarted = (may: { repoMerge?: null; repoPush?: null }) => prFacts({ workflow: null, may });
  assert.match(gates(unstarted({ repoMerge: null }), { kind: "merge" }, OP) ?? "", /Merges/);
  assert.match(gates(unstarted({ repoPush: null }), { kind: "conflict", bucket: "merge" }, OP) ?? "", /Pushes/);
  assert.match(gates(off("commentApproved"), { kind: "fixup", bucket: "ask" }, OP) ?? "", /Comments/);
  assert.match(gates(off("commentApproved"), { kind: "post-review" }, OP) ?? "", /Comments/);
  assert.match(gates(off("ciApproved"), { kind: "approve-ci" }, OP) ?? "", /CI run approvals/);
  assert.match(gates(off("ciApproved"), { kind: "cifix", bucket: "rerun" }, OP) ?? "", /CI run approvals/);
  assert.equal(gates(unstarted({ repoPush: null }), { kind: "merge" }, OP), null);
});

test("gates: a tripped stage writes nothing, asks and other stages stay open", () => {
  const f = prFacts({ tripped: { fixup: "2 of the last 10 fixup pushes broke a required check" } });
  for (const w of [{ kind: "fixup", bucket: "fix" }, { kind: "conflict", bucket: "merge" }, { kind: "lint", bucket: "fixup" }] as const) assert.match(gates(f, w, OP) ?? "", /Fixup is paused: 2 of the last 10/);
  assert.match(gates(f, { kind: "fixup", bucket: "fix" }, "pipeline") ?? "", /paused/);
  assert.equal(gates(f, { kind: "fixup", bucket: "ask" }, OP), null);
  assert.equal(gates(f, { kind: "cifix", bucket: "work" }, OP), null);
  assert.match(gates(prFacts({ tripped: { merge: "main is red" } }), { kind: "merge" }, OP) ?? "", /Merge is paused/);
});

test("the merge command gets the reviewed head, and the built-in command refuses another head", async () => {
  const g = await guard(await fresh([{ n: 1 }]), ref, MERGE, OP, live());
  assert.ok(ok(g));
  const seen: string[][] = [];
  await mergeViaCommand({ db: await fresh([{ n: 1 }]), login: "t" }, async (_c, args) => { seen.push(args); return { code: 0, stdout: "", stderr: "" }; }, "safe-merge",
    g as Exclude<typeof g, { refused: string }>, { method: "squash" });
  assert.deepEqual(seen[0], [slugOf("app"), "1", "--squash", "--head", "sha1"]);
  assert.equal(parseSafeMergeArgs(seen[0]!)?.head, "sha1");
  const gh = async () => JSON.stringify({ state: "OPEN", isDraft: false, mergeable: "MERGEABLE", headRefOid: "other0000", statusCheckRollup: [] });
  const r = await safeMerge("o/r", "1", "--squash", [], [], gh, async () => {}, false, "sha1");
  assert.deepEqual(r, { merged: false, reason: "REFUSED o/r#1: head is other00, not the reviewed sha1" });
});

test("a repo write needs the repo's approval and, for the pipeline, the global switch", async () => {
  const db = await fresh([{ n: 1 }]);
  assert.match(why(await guardRepo(db, "app", "comment", OP)), /Comments in app are not approved/);
  await setCommentApproval(db, "op", "app", true);
  assert.ok(ok(await guardRepo(db, "app", "comment", OP)));
  assert.match(why(await guardRepo(db, "app", "comment", "pipeline")), /pipeline is off/i);
});

test("a write function refuses a guard that was made for another repo", async () => {
  const q = { spent: 0, remaining: null, query: async () => ({}) };
  await assert.rejects(closeItem({ db: await fresh([{ n: 1 }]), login: "t" }, G("other"), q, { repo: "app", number: 1, id: "N1", pr: false }), /guard covers other/);
});

test("a batch member passes the batch guard only with a passed verification and not as a draft, also while GitHub's mergeable state is still unknown", async () => {
  const batch = async (verification: string): Promise<Db> => {
    const db = (await (await (await (await (await (await (await world()).repo(["comment"])).pr(1)).review(1)).verified(1, verification)).premerge(1, "clean")).pipeline(false)).db;
    await db.prepare("INSERT INTO merge_batches (id, repo, branch, state, base_sha, commit_sha, pr_number, created_at, updated_at) VALUES (1, 'app', 'integration-app-1', 'open', 'base', 'tip', 900, ?, ?)").run(T, T);
    await db.prepare("INSERT INTO merge_batch_prs (batch_id, number, head_oid, position) VALUES (1, 1, 'sha1', 0)").run();
    return db;
  };
  const batchLive = (draft: boolean): Live => async (_r, n) => (n === 900 ? { ...open, head: "tip" } : { ...open, mergeable: "UNKNOWN", draft });
  const run = (db: Db, draft = false) => guardBatchMerge(db, { repo: "app", number: 900, head: "tip" }, [{ number: 1, head: "sha1" }], OP, batchLive(draft));
  assert.ok(ok(await run(await batch("passed"))), why(await run(await batch("passed"))));
  assert.ok(!ok(await run(await batch("failed"))));
  assert.match(why(await run(await batch("passed"), true)), /it is a draft/);
});

test("a fix-up grant is for the Plan action's source", async () => {
  const db = await takeFix();
  const ask = (source: string) => guard(db, ref, { kind: "fixup", bucket: "fix", head: "sha1", source }, OP, live());
  assert.ok(ok(await ask("review")), why(await ask("review")));
  assert.ok(!ok(await ask("carry")));
});
