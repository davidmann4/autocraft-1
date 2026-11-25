// The Plan cache: `item_plans` holds what the planner decided for each PR and item at the end of its last pass, for the
// dashboard to read. The planner is its only writer. A pass writes the rows that changed, and deletes the rows of items that
// left the Plans, in one transaction.
import { holdWait } from "../outside.ts";
import { cifixBucket, fixupOf, mergeEntry, queueEntry } from "./decide.ts";
import { nextStep } from "./decide-item.ts";
import { mergeDecisionId } from "./rules.ts";
import { isWork } from "./assignment.ts";
import type { ItemFacts, MergePath, Plan, PrFacts, WaitKind } from "./plan.ts";
import { isQueueState } from "./plan.ts";
import { statusOf, type ItemStatus } from "./item-status.ts";
import { loadPlanSet, type PlanSet, type PlanSetOptions } from "./plan-set.ts";
import type { Db } from "../db/index.ts";
import { excluded, tupleIn } from "../db/kx.ts";

/** The merge-queue fields of a PR whose Plan is in a queue state: what the Queue page and the flow counts show besides the Plan's own state, reasons and note. */
export type QueueView = {
  author: string | null; tier: string; head: string; size: string; label: string | null; /** Null for a merge-entry PR, which has no review. */ verdict: "take" | "take-fix" | null; reason: string; fixes: number;
  ci: string; mergeable: string; path: MergePath; eligible: boolean; decisionId: string | null; answer: string | null; refusedReason: string | null;
  reviewedAt: string; held: boolean; blockedLive: boolean; noCi: boolean; runsWaiting: number; runsBlocked: "off" | "failed" | "unsupported" | null;
  verify: { state: string; kind: string | null; summary: string | null; note: string | null } | null;
  conflictNote?: string; mainFix?: true;
};

export type FixupBucket = "fix" | "unapproved" | "asked" | "hold";
export type CifixBucket = "cifix-queued" | "cifix-rerun" | "cifix-failed";

/** What the dashboard reads besides the Plan columns, per row; keys are left out when empty. */
export type PlanView = {
  /** The Work page's next-step text; absent for a PR outside the item facts (merged, or in an untracked repo). */
  next?: string;
  /** In the pipeline's scope and not our own integration PR. */
  scope?: true;
  /** Settled label of the current classification run. */
  label?: string;
  /** GitHub state of a PR. */
  gh?: "OPEN" | "MERGED" | "CLOSED";
  fixup?: FixupBucket;
  cifix?: CifixBucket;
  queue?: QueueView;
  /** Who the wait is on, as the planner typed it; absent when nothing is awaited (read by the liveness check). */
  waitKind?: WaitKind;
  /** Phase, wait and next step; `since` is when phase or wait last changed. */
  status: ItemStatus;
};

export type PlanRow = {
  repo: string; number: number; kind: "pr" | "issue"; head: string | null; state: string; item_state: string | null;
  actions: string; wait: string | null; reasons: string; note: string | null; view: string;
};

const CIFIX_BUCKETS: Record<string, CifixBucket> = { work: "cifix-queued", formatting: "cifix-queued", collect: "cifix-queued", linting: "cifix-queued", rerun: "cifix-rerun", "rerun-wait": "cifix-rerun", "comment-wait": "cifix-queued", failed: "cifix-failed", capped: "cifix-failed" };

/** The fix-up bucket the flow counts show for a PR: a take-fix review's own, or a pre-merge round's. */
function fixupBucketOf(f: PrFacts, plan: Plan): FixupBucket | undefined {
  const x = fixupOf(f);
  if (x) return x.bucket === "fix" || x.bucket === "unapproved" || x.bucket === "asked" ? x.bucket : "hold";
  if (f.premerge && plan.actions.some((a) => a.kind === "fixup" && a.params?.source === "premerge")) return f.pushable && f.repoFacts.pushApproved ? "fix" : f.pushable ? "unapproved" : "hold";
  return undefined;
}

function queueViewOf(f: PrFacts, plan: Plan): QueueView {
  // A merge-entry PR is queued at its own head without a review; it joined the queue when its workflow started.
  const r = mergeEntry(f) ? null : f.review!;
  const head = r?.head ?? f.head ?? "";
  const merged = plan.state === "merged";
  const x = queueEntry(f, merged, !merged);
  return {
    author: f.author, tier: f.tier, head, size: f.size, label: f.label, verdict: r ? r.verdict as "take" | "take-fix" : null, reason: r?.reason ?? "", fixes: r?.fixes ?? 0, ci: f.ci, mergeable: f.mergeable,
    path: plan.path, eligible: plan.eligible, decisionId: f.decision.asked ? mergeDecisionId(f.repo, f.number, head) : null, answer: x.answer, refusedReason: x.refusedReason,
    reviewedAt: r?.at ?? f.workflow?.startedAt ?? "", held: f.mergeHeld, blockedLive: plan.state === "changes-requested" && !!f.changesRequested?.live, noCi: x.noCi,
    runsWaiting: f.runs?.waiting ?? 0, runsBlocked: f.runs?.blocked ?? null, verify: f.verification,
    ...(plan.conflictNote !== null ? { conflictNote: plan.conflictNote } : {}), ...(f.mainFix ? { mainFix: true as const } : {}),
  };
}

function viewOf(pr: { facts: PrFacts; plan: Plan } | null, item: { facts: ItemFacts; plan: Parameters<typeof nextStep>[0] } | null, wait: string | null, waitKind: WaitKind | null, plannedAt: string): PlanView {
  const v = { status: { phase: "Triage", waiting: null, next: null, since: plannedAt } } as PlanView;
  if (item) {
    v.next = nextStep(item.plan, item.facts, pr?.facts ?? null);
    if (item.facts.inScope && !item.facts.integration) v.scope = true;
    if (item.facts.classification.label) v.label = item.facts.classification.label;
  } else if (pr && pr.facts.inScope && !pr.facts.integration) v.scope = true;
  if (pr) {
    v.gh = pr.facts.ghState;
    const fx = fixupBucketOf(pr.facts, pr.plan);
    if (fx) v.fixup = fx;
    const cf = cifixBucket(pr.facts);
    if (cf && CIFIX_BUCKETS[cf]) v.cifix = CIFIX_BUCKETS[cf];
    if (isQueueState(pr.plan.state) && pr.facts.review) v.queue = queueViewOf(pr.facts, pr.plan);
  }
  if (wait !== null && waitKind) v.waitKind = waitKind;
  v.status = {
    ...statusOf({ gh: pr?.facts.ghState ?? null, state: pr?.plan.state ?? null, itemState: item?.plan.state ?? null, wait, waitKind, scopeAnswered: pr?.facts.scopeAnswer != null, next: v.next ?? null, reviewBlocked: pr?.facts.reviewHold?.kind === "blocked", inPipeline: item?.facts.inScope ?? pr?.facts.inScope, ...((item?.facts.outsideHold ?? pr?.facts.outsideHold) ? { outside: (item?.facts.outsideHold ?? pr?.facts.outsideHold)! } : {}) }),
    since: plannedAt,
  };
  return v;
}

/** One row per PR or item of the set. A PR with item facts gets both its plans in one row. */
export function planRows(plans: PlanSet, plannedAt: string = new Date().toISOString()): PlanRow[] {
  const prs = new Map(plans.prs.map((p) => [`${p.facts.repo}#${p.facts.number}`, p]));
  const rows: PlanRow[] = [];
  for (const { facts: f, plan: item } of plans.items) {
    const ref = `${f.repo}#${f.number}`;
    const pr = prs.get(ref) ?? null;
    prs.delete(ref);
    const actions = [...item.actions, ...(pr?.plan.actions ?? [])];
    const work = actions.some(isWork);
    const hold = f.outsideHold ?? pr?.facts.outsideHold;
    const wait = hold ? holdWait(hold) : work ? null : pr?.plan.wait ?? item.wait;
    const waitKind = hold ? "system" as const : work ? null : pr?.plan.wait != null ? pr.plan.waitKind : item.waitKind;
    rows.push({
      repo: f.repo, number: f.number, kind: f.kind, head: pr?.facts.head ?? null, state: pr ? pr.plan.state : item.state, item_state: item.state,
      actions: JSON.stringify(actions), wait, reasons: JSON.stringify(pr?.plan.reasons ?? []), note: pr?.plan.note ?? null,
      view: JSON.stringify(viewOf(pr, { facts: f, plan: item }, wait, waitKind, plannedAt)),
    });
  }
  // PRs outside the item facts: merged ones with a take review, and PRs of repos that are not tracked.
  for (const { facts: f, plan } of prs.values()) {
    rows.push({ repo: f.repo, number: f.number, kind: "pr", head: f.head, state: plan.state, item_state: null, actions: JSON.stringify(plan.actions), wait: plan.wait, reasons: JSON.stringify(plan.reasons), note: plan.note, view: JSON.stringify(viewOf({ facts: f, plan }, null, plan.wait, plan.waitKind, plannedAt)) });
  }
  return rows;
}

/** Rows per multi-row insert: well under the bound-parameter limits of both engines at a dozen columns a row. */
const BATCH_ROWS = 1000;
const batches = <T>(rows: readonly T[]): T[][] => Array.from({ length: Math.ceil(rows.length / BATCH_ROWS) }, (_, i) => rows.slice(i * BATCH_ROWS, (i + 1) * BATCH_ROWS));

const sig = (r: PlanRow): string => JSON.stringify([r.kind, r.head, r.state, r.item_state, r.actions, r.wait, r.reasons, r.note, r.view]);

type Stored = { sig: string; status: ItemStatus | undefined; state: string; wait: string | null; head: string | null };

// The stored rows as of item_plans_rev `rev`, kept between passes: the table is read again only after a write this connection did not make.
const storedMemo = new WeakMap<Db, { rev: number; rows: Map<string, Stored> }>();

const planRev = async (db: Db): Promise<number | null> => (await db.get(db.k.selectFrom("main.item_plans_rev").select("rev").where("id", "=", 1)))?.rev ?? null;

const storedOf = (r: PlanRow): Stored => ({ sig: sig(r), status: (JSON.parse(r.view) as Partial<PlanView>).status, state: r.state, wait: r.wait, head: r.head });

const readStored = async (db: Db): Promise<Map<string, Stored>> => {
  const rows = new Map<string, Stored>();
  for (const r of await db.all(db.k.selectFrom("main.item_plans").select(["repo", "number", "kind", "head", "state", "item_state", "actions", "wait", "reasons", "note", "view"]).$narrowType<{ kind: PlanRow["kind"] }>())) rows.set(`${r.repo}#${r.number}`, storedOf(r));
  return rows;
};

async function storedRows(db: Db): Promise<{ rev: number | null; rows: Map<string, Stored> }> {
  // The counter is read before the rows: a write between the two leaves the memo older than its rev, so the next pass reads again.
  const rev = await planRev(db);
  const hit = storedMemo.get(db);
  if (hit && rev !== null && hit.rev === rev) return { rev, rows: hit.rows };
  const rows = await readStored(db);
  if (rev !== null) storedMemo.set(db, { rev, rows });
  else storedMemo.delete(db);
  return { rev, rows };
}

/** Writes the rows that differ from the stored ones and deletes the stored rows with no Plan. Returns the numbers written and deleted. */
export async function writePlanCache(db: Db, plans: PlanSet, plannedAt: string = new Date().toISOString()): Promise<{ written: number; deleted: number }> {
  const planned = planRows(plans, plannedAt);
  const diff = (stored: Map<string, Stored>) => {
    // `since` moves only when phase or wait does; recomputing it every pass would change every row's signature.
    const rows = planned.map((r) => {
      const old = stored.get(`${r.repo}#${r.number}`)?.status;
      const v = JSON.parse(r.view) as PlanView;
      return old && old.phase === v.status.phase && old.waiting === v.status.waiting && old.since !== v.status.since ? { ...r, view: JSON.stringify({ ...v, status: { ...v.status, since: old.since } }) } : r;
    });
    const changed = rows.filter((r) => stored.get(`${r.repo}#${r.number}`)?.sig !== sig(r));
    const keep = new Set(rows.map((r) => `${r.repo}#${r.number}`));
    return { changed, gone: [...stored.keys()].filter((k) => !keep.has(k)) };
  };
  const first = await storedRows(db);
  let stored = first.rows;
  let { changed, gone } = diff(stored);
  if (!changed.length && !gone.length) return { written: 0, deleted: 0 };
  // The memo is dropped until the write commits and is brought up to date after it.
  storedMemo.delete(db);
  const rev = await db.write(async () => {
    // A write by another connection since the rows were read is in the table but not in `stored`: read the rows again under the lock and diff against those.
    if (await planRev(db) !== first.rev) {
      stored = await readStored(db);
      ({ changed, gone } = diff(stored));
    }
    const history = changed.flatMap((r) => {
      const old = stored.get(`${r.repo}#${r.number}`);
      return !old || old.state !== r.state || old.wait !== r.wait ? [{ repo: r.repo, number: r.number, head: r.head, old_state: old?.state ?? null, new_state: r.state, old_wait: old?.wait ?? null, wait: r.wait, reasons: r.reasons, at: plannedAt }] : [];
    });
    // A row for each exit, so the item's return does not read as a first plan.
    const exits = gone.map((k) => {
      const i = k.lastIndexOf("#"), old = stored.get(k)!;
      return { repo: k.slice(0, i), number: Number(k.slice(i + 1)), head: old.head, old_state: old.state, new_state: "gone", old_wait: old.wait, wait: null, reasons: "[]", at: plannedAt };
    });
    for (const rows of batches([...history, ...exits])) await db.run(db.k.insertInto("main.plan_history").values(rows));
    for (const rows of batches(changed)) {
      await db.run(db.k.insertInto("main.item_plans").values(rows.map((r) => ({ repo: r.repo, number: r.number, kind: r.kind, head: r.head, state: r.state, item_state: r.item_state, actions: r.actions, wait: r.wait, reasons: r.reasons, note: r.note, view: r.view, planned_at: plannedAt })))
        .onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(excluded(["kind", "head", "state", "item_state", "actions", "wait", "reasons", "note", "view", "planned_at"]))));
    }
    if (exits.length) await db.run(db.k.deleteFrom("main.item_plans").where(tupleIn(db, ["repo", "number"], exits.map((e) => [e.repo, e.number]), ["text", "bigint"])));
    // Read under the write lock: no other write can land between the rows this transaction diffed against (or wrote) and the counter.
    return await planRev(db);
  });
  for (const r of changed) stored.set(`${r.repo}#${r.number}`, storedOf(r));
  for (const k of gone) stored.delete(k);
  if (rev !== null) storedMemo.set(db, { rev, rows: stored });
  return { written: changed.length, deleted: gone.length };
}

/** Plans decided and cached at once: the planner's own pass does this after every detection. */
export async function refreshPlanCache(db: Db, opts: PlanSetOptions = {}): Promise<{ written: number; deleted: number }> {
  return await writePlanCache(db, await loadPlanSet(db, opts));
}

export type PlanHistoryRow = { head: string | null; oldState: string | null; newState: string; oldWait: string | null; wait: string | null; reasons: string[]; at: string };

/** The state changes of an item's plan, oldest first. */
export async function planHistory(db: Db, repo: string, number: number): Promise<PlanHistoryRow[]> {
  return (await db.all(db.k.selectFrom("main.plan_history").select(["head", "old_state", "new_state", "old_wait", "wait", "reasons", "at"]).where("repo", "=", repo).where("number", "=", number).orderBy("id")))
    .map((r) => ({ head: r.head, oldState: r.old_state, newState: r.new_state, oldWait: r.old_wait, wait: r.wait, reasons: JSON.parse(r.reasons) as string[], at: r.at }));
}

/** Deletes plan history older than `keepMs` (the jobs' horizon). Returns the number of rows. */
export async function prunePlanHistory(db: Db, keepMs: number, nowMs: number = Date.now()): Promise<number> {
  return Number((await db.run(db.k.deleteFrom("main.plan_history").where("at", "<", new Date(nowMs - keepMs).toISOString()))).changes);
}
