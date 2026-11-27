// Shared setup of the test/workflow-start*.test.ts files.
import assert from "node:assert/strict";
import { afterEach } from "node:test";
import { textHash } from "../src/core/open-prs.ts";
import { addOwnCommits } from "../src/data/control/index.ts";
import { recordSteps, startAttempt } from "../src/data/implement/index.ts";
import { mergeMay } from "../src/core/gates.ts";
import { loadPrFact } from "../src/core/facts.ts";
import { doCard } from "../src/conversations/act.ts";
import { parseReply } from "../src/conversations/cards.ts";
import { ensureConversation, insertTurn } from "../src/conversations/store.ts";
import { mergeVerdicts } from "../src/merge/approval.ts";
import { advancePreapprovals } from "../src/preapproval/index.ts";
import { advanceWorkflows } from "../src/workflow/advance.ts";
import { runCommand, type Actor } from "../src/workflow/apply.ts";
import { parse } from "../src/workflow/parse.ts";
import { liveWorkflow } from "../src/workflow/store.ts";
import { LANES, planCtx } from "../src/runner/autopilot.ts";
import { T0, untilQuiet, world, type World } from "./world-db.ts";

let current: World | undefined;
afterEach(() => current?.close());

export const MAINT = "mira";
export const actor: Actor = { login: MAINT, canWrite: async () => true };
export const send = async (w: World, text: string, number = 1, head?: string) =>
  (await runCommand(w.db, actor, "github", { parsed: parse(text), items: [{ repo: "app", number }], ...(head ? { head } : {}) })).items[0]!;
export const run = async (w: World, text: string, number = 1) => {
  const o = await send(w, text, number);
  assert.equal(o.outcome, "run", `${text}: ${o.line}`);
};

/** A feature PR nobody started, in a repo that approved neither merges nor pushes; its facts are ready for a merge at sha1. */
export async function unstarted(pipeline = true): Promise<World> {
  const w = current = await (await (await world()).repo(["merge", "push"])).acting(MAINT);
  await w.db.run(w.db.k.updateTable("main.tracked_repos").set({ pipeline: pipeline ? 1 : 0 }));
  return await (await (await w.pr(1, { label: "feature" })).verified(1)).premerge(1, "clean");
}
export const settle = (w: World) => untilQuiet(w.db, [() => advanceWorkflows(w.db), () => advancePreapprovals(w.db)], 5);
/** The newest leg is handed over, belongs to the live workflow, and the planner merges the PR at `head` as MAINT. */
export async function mergesAsPerson(w: World, head = "sha1"): Promise<void> {
  const wf = (await liveWorkflow(w.db, "app", 1))!;
  const leg = (await w.rows("SELECT state, workflow_id, reason FROM preapprovals WHERE number = 1 ORDER BY id DESC"))[0];
  assert.deepEqual({ state: leg?.state, workflow: leg?.workflow_id }, { state: "queued", workflow: wf.id }, String(leg?.reason ?? ""));
  assert.equal(wf.approvedBy, MAINT);
  assert.ok((await w.prPlan(1)).actions.some((a) => a.kind === "merge" && a.head === head), JSON.stringify(await w.prPlan(1)));
  assert.deepEqual(mergeMay((await loadPrFact(w.db, "app", 1))!), { ok: true, as: "person", by: MAINT });
  assert.deepEqual((await mergeVerdicts(w.db, "app", [{ number: 1, head }])).get(1), { ok: true, as: `user:${MAINT}`, by: { kind: "person", login: MAINT } });
}
export const review = async (w: World, head = "sha1") => {
  // The review a start asked for: newer than the start.
  await w.review(1, { head });
  await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ at: new Date(Date.now() + 1000).toISOString() }).where("number", "=", 1));
};

/** Presses a card of the PR's conversation that proposes the command. */
export async function press(w: World, text: string): Promise<void> {
  await ensureConversation(w.db, "app", 1, MAINT);
  const p = (await parseReply(w.db, "app", 1, `Text.\n\`\`\`actions\n${JSON.stringify([{ kind: "resolution", steps: [{ kind: "command", text }] }])}\n\`\`\``))!;
  const turn = await insertTurn(w.db, "app", 1, { kind: "opus", login: "opus", body: "Text.", block: "x", cards: p.cards });
  const id = Number((await w.db.get(w.db.k.selectFrom("main.conversation_cards").select("id").where("turn_id", "=", turn)))!.id);
  const { card } = await doCard(w.db, id, MAINT, { canWrite: async () => true });
  assert.equal(card.state, "done", card.error ?? "");
}
/** The fix-up of the PR's newest request pushed `to`, and its review, checks and pre-merge review are clean. */
export async function pushed(w: World, from: string, to: string): Promise<void> {
  const fix = (await w.rows("SELECT id FROM operator_fixups WHERE number = 1 ORDER BY id DESC"))[0]!.id as number;
  await w.db.run(w.db.k.insertInto("main.fixups").values({ repo: "app", number: 1, from_head: from, to_head: to, state: "pushed", attempt: 1, created_at: new Date().toISOString(), source: "operator", operator_fix: fix }));
  await w.synced(1, to);
  await review(w, to);
  await (await w.verified(1)).premerge(1, "clean");
}

/** An attempt of issue 7 an earlier workflow made, with its PR 8. */
export async function earlier(w: World, o: { state: string; pr: "CLOSED" | "MERGED" | "OPEN" }): Promise<number> {
  await w.pr(8, { author: "craft-bot" });
  await w.db.run(w.db.k.updateTable("main.items").set({ state: o.pr, closed_at: o.pr === "OPEN" ? null : T0 }).where("number", "=", 8));
  const it = (await w.db.get(w.db.k.selectFrom("main.items").select(["title", "body"]).where("number", "=", 7)))!;
  const im = (await startAttempt(w.db, { repo: "app", number: 7, queuedBy: MAINT, textHash: textHash(it.title ?? "", it.body ?? "") }, T0))!;
  await recordSteps(w.db, [{ id: im.id, to: o.state as "closed", patch: { prNumber: 8, branch: "fix-8", prUrl: "https://example.invalid/8" } }], T0);
  return im.id;
}

/** Issue 7 implemented (approved when `text` says so), PR 8 opened by it at sha8. */
export async function implementing(text: string): Promise<World> {
  const w = await (await unstarted(false)).issue(7);
  await run(w, text, 7);
  await earlier(w, { state: "pr-opened", pr: "OPEN" });
  await addOwnCommits(w.db, [{ repo: "app", sha: "sha8", action: "implement-push" }]);
  await settle(w);
  return w;
}
export const legs8 = async (w: World) => await w.rows("SELECT workflow_id, state FROM preapprovals WHERE number = 8 ORDER BY id");

/** Runs `fn` once, before the next write transaction of `db` starts. */
export function before(db: World["db"], fn: () => Promise<unknown>): void {
  const write = db.write;
  db.write = (async (f: () => Promise<unknown>, o?: never) => {
    db.write = write;
    await fn();
    return await write.call(db, f, o);
  }) as typeof write;
}

/** The newest review of the PR, made after its workflow's start. */
export const reviewed = async (w: World, number: number, o: Parameters<World["review"]>[1]): Promise<void> => {
  await w.review(number, o);
  await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ at: new Date(Date.now() + 1000).toISOString() }).where("number", "=", number));
};
export const acts = async (w: World, number: number) => (await w.prPlan(number)).actions.map((a) => [a.kind, a.params?.bucket].filter(Boolean).join(":"));
export const steps = async (w: World, number: number) => (await acts(w, number)).filter((a) => /^(fixup|cifix|implement)/.test(a));
export const fails = async (w: World, number: number) =>
  void await w.db.run(w.db.k.updateTable("main.pr_checks").set({ overall: "failure", checks: JSON.stringify([{ name: "test", state: "failure" }]) }).where("number", "=", number));
export const implementJobs = async (w: World) =>
  (await LANES.find((l) => l.name === "implement")!.detect(w.db, await planCtx(w.db))).map((c) => [c.params.number, c.params.bucket]);

/** The push of the conflict merge of sha1 went through. */
export const pushRecorded = (w: World) => w.db.run(w.db.k.insertInto("main.push_outcomes").values({
  at: new Date().toISOString(), stage: "fixup", action: "conflict-push", repo: "app", number: 1, from_oid: "sha1", to_oid: "sha1b", before_res: "unknown",
}));

/** A PR whose review conflicts with its base branch, back with its recommendation. */
export async function conflicting(o: { verdict: "take" | "take-fix"; fixes?: { file: string; change: string; title?: string; major?: boolean }[]; canModify?: boolean; before?: (w: World) => Promise<unknown> }): Promise<World> {
  const w = await unstarted(false);
  await w.db.run(w.db.k.updateTable("main.items").set({ base_ref: "main" }).where("number", "=", 1));
  await run(w, "review");
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ mergeable: "CONFLICTING", maintainer_can_modify: o.canModify === false ? 0 : 1 }));
  await o.before?.(w);
  await reviewed(w, 1, { verdict: o.verdict, ...(o.fixes ? { fixes: o.fixes } : {}) });
  await settle(w);
  return w;
}
export const conflictRow = (w: World, from_head: string, state: string, o: { to_head?: string; own_diff?: string; at?: string } = {}) =>
  w.db.run(w.db.k.insertInto("main.conflict_merges").values({ repo: "app", number: 1, from_head, to_head: o.to_head ?? null, base_sha: "base", state, attempt: 1, created_at: o.at ?? new Date().toISOString(), ...(o.own_diff ? { own_diff: o.own_diff } : {}) }));
/** The base was merged into sha1, and the mirror shows sha1b. */
export const baseMerged = async (w: World) => {
  await conflictRow(w, "sha1", "merged", { to_head: "sha1b", own_diff: "same" });
  await pushRecorded(w);
  await settle(w);
  await w.synced(1, "sha1b");
  await w.db.run(w.db.k.updateTable("main.pr_checks").set({ fetched_at: new Date().toISOString() }));
  await w.db.run(w.db.k.updateTable("main.items").set({ updated_at: new Date(Date.now() + 1000).toISOString(), mergeable: "MERGEABLE", maintainer_can_modify: 1 }).where("number", "=", 1));
};
