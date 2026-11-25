// What a maintainer's command does to the machinery that already works: the review-again mark, operator fix-ups, pre-approved
// merges (the merge leg, owned through preapprovals.workflow_id), the fast_track row (scope, the implement queue and the weight),
// the Backlog answer, Act's close made as the person, autorepin and the stop of every queued step. The command core
// (apply.ts) calls these and then writes the workflow row; nothing here touches item_workflows.
//
// Every start also writes the legacy rows (fast_track, preapprovals, operator_fixups), so `workflow flip <repo> --legacy`
// leaves the old planner with everything it needs.
import { audit } from "../dash/audit.ts";
import { t } from "../i18n/index.ts";
import { backlogItem } from "../dash/api/decisions.ts";
import { applyAnswer } from "../dash/api/decisions.ts";
import { queueIssue } from "../dash/api/queue-page.ts";
import { CLOSE_OPTIONS, closeDecisionId } from "../act/index.ts";
import { endWorkspace } from "../build/workspaces.ts";
import { HEAD_FACT } from "../core/rules.ts";
import { SCOPE_OPTIONS } from "../decide/decision.ts";
import { ask, getDecision } from "../decisions.ts";
import type { Db } from "../db/index.ts";
import { addFastTrack, removeFastTrack, setFastTrackWeight } from "../fasttrack.ts";
import type { Exec } from "../fixup/git.ts";
import { currentImplementation, moveImplementationIf } from "../implement/store.ts";
import { holdMerge, releaseMerge, removeFromBatch } from "../merge/controls.ts";
import { releaseOutside } from "../outside.ts";
import { setRepoPipeline } from "../pilot.ts";
import { cancelPreapproval, inActiveBatch, INSTRUCTIONS_MAX, preapproveMerge, PreapprovalRefused, runPipelineStep } from "../preapproval/index.ts";
import { resumeStage } from "../push-outcomes.ts";
import { withdrawCall } from "../remote/calls.ts";
import { parseBranch, parsePrRef } from "../repin/manifest.ts";
import { requestRepin } from "../repin/index.ts";
import { markReviewsStale } from "../review/discussion.ts";
import type { ItemKind, ItemWorkflow, PlanPart, Surface } from "./types.ts";

/** A legacy step refused the command; its message says why, translated (`effectText`). */
export class EffectError extends Error {}

/**
 * The refusals of the legacy steps a command runs on, as translated text. The steps write English for logs and the classic pages; a
 * refusal this table does not know stays as written.
 */
const LEGACY_TEXT: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^(\S+#\d+) is not a pull request$/, (m) => t("{ref} is not a pull request.", { ref: m[1]! })],
  [/^(\S+#\d+) is not open$/, (m) => t("{ref} is not open.", { ref: m[1]! })],
  [/^(\S+#\d+) is outside the pipeline's scope/, (m) => t("{ref} is outside the pipeline's scope.", { ref: m[1]! })],
  [/^(\S+#\d+) cannot be reviewed yet: it is a draft$/, (m) => t("{ref} is a draft, so it cannot be reviewed yet.", { ref: m[1]! })],
  [/^(\S+#\d+) cannot be reviewed yet: it is in the backlog$/, (m) => t("{ref} is in the backlog, so it cannot be reviewed yet.", { ref: m[1]! })],
  [/^(\S+#\d+) cannot be reviewed yet: it is held as a duplicate$/, (m) => t("{ref} is held as a duplicate, so it cannot be reviewed yet.", { ref: m[1]! })],
  [/^(\S+#\d+) cannot be reviewed yet: (.+)$/, (m) => t("{ref} cannot be reviewed yet: {why}", { ref: m[1]!, why: m[2]! })],
  [/^(\S+#\d+) has no head commit in the mirror yet$/, (m) => t("AutoCraft has not read the head commit of {ref} yet.", { ref: m[1]! })],
  [/^the PR changed after your comment; comment again$/, () => t("The pull request changed after the command was written. Send it again.")],
  [/^merging is not approved for (\S+)$/, (m) => t("Merging is not approved for {repo}. An operator or a maintainer of the repo can turn it on, on the Repos page.", { repo: m[1]! })],
  [/^pushing is not approved for (\S+)$/, (m) => t("Pushing is not approved for {repo}. An operator or a maintainer of the repo can turn it on, on the Repos page.", { repo: m[1]! })],
  [/^(\S+#\d+) already has a pre-approved merge in progress$/, (m) => t("{ref} is already on its way to a merge.", { ref: m[1]! })],
  [/^(\S+#\d+) conflicts with its base branch/, (m) => t("{ref} conflicts with its base branch: the conflict merge comes first.", { ref: m[1]! })],
  [/^can't push to the contributor's branch$/, () => t("AutoCraft can't push to the contributor's branch.")],
  [/^the fix-up tries for this PR are used up$/, () => t("The fix-up tries for this pull request are used up.")],
  [/^a fix-up of (\S+#\d+) is already queued$/, (m) => t("A fix-up of {ref} is already queued.", { ref: m[1]! })],
  [/^the instructions are over (\d+) characters$/, (m) => t("The fix-up instructions are over {n} characters.", { n: m[1]! })],
  [/^the author's permission on the repository could not be read yet/, () => t("The author's permission on the repository could not be read yet. Try again.")],
  [/^(\S+#\d+) has no pre-approved merge in progress$/, (m) => t("{ref} is not on its way to a merge.", { ref: m[1]! })],
];

/** A legacy step's refusal as translated text; unknown text stays as written. */
export function effectText(message: string): string {
  for (const [re, text] of LEGACY_TEXT) {
    const m = re.exec(message);
    if (m) return text(m);
  }
  return message;
}

export type Target = { repo: string; number: number; kind: ItemKind; head: string | null };
/** `workflowId`: the item's live workflow, whose merge legs (possibly on another item: an issue's implementation PR) a stop ends. */
export type Ctx = { db: Db; by: string; via: Surface; at: string; item: Target; exec?: Exec; workflowId?: number };

const ref = (t: Target): string => `${t.repo}#${t.number}`;
const ACTIVE_PREAPPROVAL = ["fixup", "review", "ci", "queued"];

/** Turns a refusal of an existing step into an EffectError, so the item's line says why and the other items go on. */
async function step<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw e instanceof EffectError ? e : new EffectError(effectText((e as Error).message));
  }
}

const activePreapproval = async (db: Db, t: Target): Promise<number | null> =>
  (await db.get(db.k.selectFrom("main.preapprovals").select("id").where("repo", "=", t.repo).where("number", "=", t.number)
    .where("state", "in", ACTIVE_PREAPPROVAL).orderBy("id", "desc").limit(1)))?.id ?? null;

// ---- weight and scope (fast_track) ---------------------------------------------------------------------------------------

/** The item's fast_track row with exactly `weight`: added when missing, re-weighted when it differs. */
export async function storeWeight(c: Ctx, weight: number): Promise<void> {
  const r = ref(c.item);
  const had = (await c.db.get(c.db.k.selectFrom("main.fast_track").select("weight").where("repo", "=", c.item.repo).where("number", "=", c.item.number)))?.weight;
  await step(async () => {
    if (had === undefined) await addFastTrack(c.db, c.by, r, weight, c.via);
    else if (had !== weight) await setFastTrackWeight(c.db, c.by, r, weight, c.via);
  });
}

// ---- starts --------------------------------------------------------------------------------------------------------------

/** The merge leg: a pre-approved merge at the current head, or the one already in progress. Returns its id. */
async function mergeLeg(c: Ctx): Promise<number> {
  const had = await activePreapproval(c.db, c.item);
  if (had !== null) return had;
  try {
    await preapproveMerge(c.db, { repo: c.item.repo, number: c.item.number, by: c.by, via: c.via, ...(c.item.head ? { head: c.item.head } : {}) });
  } catch (e) {
    if (!(e instanceof PreapprovalRefused && e.active)) throw new EffectError(effectText((e as Error).message));
  }
  const id = await activePreapproval(c.db, c.item);
  if (id === null) throw new EffectError(t("{ref} is not on its way to a merge.", { ref: ref(c.item) }));
  return id;
}

/**
 * Starts the item at `entry`. Review and Fix-up mark the PR for a review of its current head (the fix-up follows from what the
 * review finds); Implement queues the issue as the actor's; the merge queue pre-approves the merge. An approved PR gets its merge
 * leg now. Returns the pre-approval the workflow owns, if any.
 */
export async function start(c: Ctx, entry: ItemWorkflow["entry"], approved: boolean, weight: number): Promise<{ preapproval: number | null }> {
  const { db, by, item } = c;
  if (entry === "implement") {
    await step(() => queueIssue(db, by, item.repo, item.number, weight, c.via));
    await storeWeight(c, weight);
    return { preapproval: null };
  }
  // The pre-approval validates the PR first (open, reviewable, merging approved), so nothing else is written when it refuses.
  const preapproval = approved || entry === "merge" ? await mergeLeg(c) : null;
  await storeWeight(c, weight);
  if (entry !== "merge") await step(() => markReviewsStale(db, by, item.repo, item.number));
  return { preapproval };
}

// ---- answers on a started item -------------------------------------------------------------------------------------------

/** The fix-up instructions for the named parts of the plan; the latest review's fixes when the plan names none. */
export function fixInstructions(plan: readonly PlanPart[], fix: readonly number[]): string {
  const parts = plan.filter((p) => fix.includes(p.n));
  if (!parts.length) return "Make the fixes the latest review of this pull request lists.";
  let out = "Fix these findings of the review, and nothing else:";
  for (const p of parts) {
    const line = `\n${p.n}. ${p.title}${p.file ? ` (${p.file})` : ""}`;
    if (out.length + line.length > INSTRUCTIONS_MAX) break;
    out += line;
  }
  return out;
}

/**
 * What runs again on a started PR: a review of the current head, or a fix-up of the named parts. With `merges`, the fix-up
 * carries the merge (a new pre-approval in `fixup`), unless a pre-approved merge is already in progress; a PR with no fix-up
 * this time gets its merge leg when it has none. Returns the pre-approval the workflow owns, if any.
 */
export async function again(c: Ctx, o: { again: "review" | "fixup" | null; plan: readonly PlanPart[]; fix: readonly number[]; merges: boolean }): Promise<{ preapproval: number | null }> {
  const { db, by, item } = c;
  if (item.kind !== "pr") return { preapproval: null };
  if (o.again === "fixup") {
    const had = await activePreapproval(db, item);
    const r = await step(() => runPipelineStep(db, { repo: item.repo, number: item.number, by, step: { kind: "fixup", instructions: fixInstructions(o.plan, o.fix), merge: o.merges && had === null } }));
    return { preapproval: r.preapproval ?? (o.merges ? had : null) };
  }
  if (o.again === "review") await step(() => markReviewsStale(db, by, item.repo, item.number));
  return { preapproval: o.merges ? await mergeLeg(c) : null };
}

// ---- stop, backlog, close ------------------------------------------------------------------------------------------------

/**
 * Stops everything that runs or waits for the item: its pre-approved merge (out of its batch first), queued fix-ups, its place in
 * an integration batch, queued model calls made for it alone, the implementation attempt of an issue that has no PR yet, and its
 * fast_track row (scope and the implement queue). Leased calls finish; nothing acts on their result once the workflow stopped.
 * Every part runs; the ones that could not stop are returned.
 */
export async function stopAll(c: Ctx): Promise<string[]> {
  const { db, by, item, at } = c;
  const why = `stopped by ${by}`;
  const failed: string[] = [];
  const attempt = async (fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { failed.push(effectText((e as Error).message)); }
  };
  if (item.kind === "pr") {
    if (await activePreapproval(db, item) !== null) await attempt(() => cancelPreapproval(db, by, item.repo, item.number, c.exec, c.via));
    const fixups = await db.all(db.k.selectFrom("main.operator_fixups").select("id").where("repo", "=", item.repo).where("number", "=", item.number).where("state", "=", "queued"));
    for (const f of fixups) {
      if ((await db.run(db.k.updateTable("main.operator_fixups").set({ state: "ended" }).where("id", "=", f.id).where("state", "=", "queued"))).changes) {
        await audit(db, by, "operator-fixup", ref(item), { id: f.id, ended: true, reason: why });
      }
    }
    if (await inActiveBatch(db, item.repo, item.number)) {
      await attempt(async () => {
        const heldBefore = !!await db.get(db.k.selectFrom("main.merge_holds").select((eb) => eb.lit(1).as("one")).where("repo", "=", item.repo).where("number", "=", item.number));
        await removeFromBatch(db, by, item.repo, item.number, c.exec);
        if (!heldBefore) await releaseMerge(db, by, item.repo, item.number);
      });
    }
  } else {
    const impl = await currentImplementation(db, item.repo, item.number);
    if (impl && impl.prNumber === null && await moveImplementationIf(db, impl.id, [impl.state], "cancelled", { reason: why }, at)) {
      if (impl.workspaceId !== null) await endWorkspace(db, impl.workspaceId);
      await audit(db, by, "implement-cancel", ref(item), { id: impl.id, reason: why });
    }
  }
  // The workflow's merge legs on other items: an issue's implementation PR.
  if (c.workflowId !== undefined) {
    for (const p of await db.all(db.k.selectFrom("main.preapprovals").select("number").where("workflow_id", "=", c.workflowId).where("state", "in", ACTIVE_PREAPPROVAL)
      .where((eb) => eb.or([eb("repo", "!=", item.repo), eb("number", "!=", item.number)])))) {
      await attempt(() => cancelPreapproval(db, by, item.repo, p.number, c.exec, c.via));
    }
  }
  const calls = await db.all(db.k.selectFrom("main.remote_calls").select(["id", "items"]).where("repo", "=", item.repo).where("state", "=", "queued"));
  for (const k of calls) {
    let items: { repo?: unknown; number?: unknown }[] = [];
    try { items = JSON.parse(k.items) as typeof items; } catch { /* unreadable: not this item's */ }
    if (items.length === 1 && items[0]!.repo === item.repo && items[0]!.number === item.number) await withdrawCall(db, Number(k.id), why, ["queued"]);
  }
  await attempt(() => removeFastTrack(db, by, ref(item), c.via));
  return failed;
}

/** The Backlog: open, nothing planned. Stops what runs, then records the Backlog answer the legacy holds read. */
export async function backlog(c: Ctx): Promise<string[]> {
  const failed = await stopAll(c);
  await step(() => backlogItem(c.db, c.item.repo, c.item.number, c.by, "workflow", c.via));
  return failed;
}

/**
 * Closes the item through Act, as the person (the user lane): a close question answered Close by them, the way an answered
 * question closes any item. A PR's question names its current head, so a push after the command stops the close. Stops what
 * runs first, so no fix-up pushes to an item about to close.
 */
export async function close(c: Ctx): Promise<string[]> {
  const { db, by, item, at } = c;
  const failed = await stopAll(c);
  let id: string;
  let question: Record<string, unknown>;
  if (item.kind === "pr") {
    if (!item.head) throw new EffectError(t("AutoCraft has not read the head commit of {ref} yet.", { ref: ref(item) }));
    id = closeDecisionId(item.repo, item.number, item.head);
    question = { id, kind: "close", repo: item.repo, number: item.number, question: "Close this PR?", context: `${by} asked to close it.`,
      facts: [`${HEAD_FACT}${item.head}`], options: Object.values(CLOSE_OPTIONS).map((o) => ({ ...o })), asked_by: by, asked_at: at };
  } else {
    id = `${ref(item)}:scope:workflow-close-${Date.parse(at)}`;
    question = { id, kind: "scope", repo: item.repo, number: item.number, question: "What happens to this issue?", context: `${by} asked to close it.`,
      facts: [], options: [{ ...SCOPE_OPTIONS.close }, { ...SCOPE_OPTIONS.take }], recommended: null, asked_by: by, asked_at: at };
  }
  const had = await getDecision(db, id);
  if (had?.answer === "close") throw new EffectError(t("{ref} is already being closed on the answer of {login}.", { ref: ref(item), login: had.answered_by ?? "" }));
  if (had?.answer) throw new EffectError(t("The close question at this head was already answered {answer} by {login}.", { answer: had.answer, login: had.answered_by ?? "" }));
  if (!had) await ask(db, [question]);
  await step(async () => applyAnswer(db, (await getDecision(db, id))!, by, { answer: "close" }, "workflow", c.via));
  return failed;
}

/** Answers a question of the legacy machinery (a stuck implementation's Try again) as the person, as the dashboard would. */
export async function answerQuestion(c: Ctx, id: string, option: string): Promise<void> {
  const d = await getDecision(c.db, id);
  if (!d || d.answer) throw new EffectError(t("The question this recommendation answers is no longer open."));
  await step(() => applyAnswer(c.db, d, c.by, { answer: option }, "workflow", c.via));
}

// ---- autorepin -----------------------------------------------------------------------------------------------------------

/** The existing autorepin command, unchanged: `<pull request> [via <branch>]` or `off`. The caller has applied the act rule. */
export async function autorepin(c: Ctx, args: string, githubId: number | null): Promise<string> {
  const m = /^(\S+)(?:\s+via\s+(\S+))?$/i.exec(args.trim());
  if (!m) throw new EffectError(t("autorepin needs a pull request, or off."));
  const off = m[1]!.toLowerCase() === "off";
  const prRef = off ? null : parsePrRef(m[1]!);
  if (!off && !prRef) throw new EffectError(t("{ref} is not a pull request.", { ref: m[1]! }));
  if (githubId === null) throw new EffectError(t("AutoCraft has no GitHub id for {login} yet. Sign in to the dashboard once.", { login: c.by }));
  return await step(() => requestRepin(c.db, {
    login: c.by, githubId, role: "", canWrite: true, authorized: true, repo: c.item.repo, number: c.item.number, pr: c.item.kind === "pr",
    ref: prRef, branch: m[2] ? parseBranch(m[2]) : null, at: new Date(c.at),
  }));
}

// ---- controls ------------------------------------------------------------------------------------------------------------

/** Keeps an approved PR out of the next merge until it is released. Returns false when it was already held. */
export const hold = (c: Ctx): Promise<boolean> => step(() => holdMerge(c.db, c.by, c.item.repo, c.item.number, { via: c.via }));
export const release = (c: Ctx): Promise<boolean> => step(() => releaseMerge(c.db, c.by, c.item.repo, c.item.number));
export const releaseHeld = (c: Ctx): Promise<void> => step(() => releaseOutside(c.db, c.by, c.item.repo, c.item.number));
export const resumeBreaker = (db: Db, by: string, key: string): Promise<void> => step(() => resumeStage(db, key, by));
/** The repo's Automatic switch: whether AutoCraft works its items without a person picking them (the per-repo Pipeline switch). */
export const setAutomatic = (db: Db, by: string, repo: string, on: boolean): Promise<boolean> => step(() => setRepoPipeline(db, by, repo, on));
