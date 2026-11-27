// reads: (none; composes loaders)
// The Queue page and the batch page: what each page reads, in waves that do not grow with the number of rows.
import type { Db } from "../../db/index.ts";
import { loadTasks } from "../build/tasks-load.ts";
import type { TaskRecord } from "../build/types.ts";
import { listAudit, loadAuditActions } from "../control/audit.ts";
import type { AuditRow, HiddenRepos } from "../control/types.ts";
import { loadChecks, loadItems, openItemKeys } from "../mirror/index.ts";
import type { ItemOf, PrChecksView } from "../mirror/types.ts";
import { listBatchPage, loadBatchPage } from "../merge/batches.ts";
import type { BatchListRow, BatchPageView } from "../merge/types.ts";
import { loadRanks } from "../triage/rank.ts";
import type { RankRow } from "../triage/types.ts";
import { loadLegPass } from "../workflow/legs.ts";
import { loadQueuePositions, loadWorkScores } from "../workflow/rows.ts";
import type { Preapproval, QueuePosition } from "../workflow/types.ts";
import { LEG_STATES, loadMergeQueue, loadPipelineScope, loadQueueRanks, type CachedEntry } from "./merge-queue.ts";
import { loadRankedOpen, type WorkList, type WorkListFilter } from "./work.ts";

export type QueuePageFacts = {
  /** Of the items the merge tab can show, those in the pipeline's scope; null unless that scope is asked for. */
  scope: Set<string> | null;
  positions: Map<string, QueuePosition>;
  entries: CachedEntry[];
  work: WorkList;
  /** The issues the queued PRs close, by `repo#number` of the PR. */
  closes: Map<string, number[]>;
  /** Active pre-approved merge legs. */
  legs: Preapproval[];
  pending: Map<string, ItemOf<"card">>;
  ranks: Map<string, RankRow>;
  /** Audit rows of the `preapproval` action by leg target. */
  carried: Map<string, AuditRow[]>;
  /** The merge tab only. */
  batches: BatchListRow[];
  scores: Map<string, number>;
  /** Work scores of started open items in the visible repos. */
  workScores: Map<string, number>;
};

const refOf = (repo: string, number: number): string => `${repo}#${number}`;

/** The issues each PR closes by `repo#number`; PRs without any are left out. */
export function closingOf(links: { repo: string; number: number; closing_issues: string | null }[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const r of links) {
    if (!r.closing_issues) continue;
    try {
      const ns = (JSON.parse(r.closing_issues) as unknown[]).filter((x): x is number => typeof x === "number");
      if (ns.length) out.set(refOf(r.repo, r.number), ns);
    } catch {
      // A malformed list is left out.
    }
  }
  return out;
}

/** Wave 1 reads the page's own sets; wave 2 the items, ranks and audit rows of the pre-approved PRs. */
export async function loadQueuePage(db: Db, o: { pipelineScope: boolean; merge: boolean; visible: string[]; hidden: HiddenRepos; list: WorkListFilter }): Promise<QueuePageFacts> {
  const [scope, positions, entries, work, legPass, queued, page, workScores] = await db.together(() => Promise.all([
    o.pipelineScope ? loadPipelineScope(db) : null,
    loadQueuePositions(db),
    loadMergeQueue(db, { merged: "exclude" }),
    loadRankedOpen(db, o.list),
    loadLegPass(db),
    loadQueueRanks(db),
    o.merge ? listBatchPage(db, { hidden: o.hidden, limit: 100 }) : null,
    loadWorkScores(db, openItemKeys({ repos: o.visible })),
  ]));
  const legs = legPass.rows;
  const refs = [...new Map(legs.filter((l) => (LEG_STATES as readonly string[]).includes(l.state)).map((l) => [refOf(l.repo, l.number), { repo: l.repo, number: l.number }])).values()];
  const [pending, ranks, carried] = await db.together(() => Promise.all([
    loadItems(db, refs, "card"),
    loadRanks(db, refs),
    legs.length ? loadAuditActions(db, [...new Set(legs.map((l) => refOf(l.repo, l.number)))], ["preapproval"]) : new Map<string, AuditRow[]>(),
  ]));
  return {
    scope, positions, entries, work, closes: closingOf(queued), legs, pending, ranks, carried,
    batches: page?.batches ?? [], scores: new Map(queued.flatMap((r) => (r.score === null ? [] : [[refOf(r.repo, r.number), r.score] as const]))), workScores,
  };
}

export type BatchPageData = {
  page: BatchPageView; ci: PrChecksView | null; audit: AuditRow[]; task: TaskRecord | undefined; items: Map<string, ItemOf<"card">>;
};

const BATCH_ACTIONS = ["batch-start", "batch-build-skip", "batch-push", "batch-pr", "batch-stop", "batch-rerun", "batch-end-too-late", "batch-merged-after-end"];
const MEMBER_ACTIONS = ["batch-remove", "batch-hold", "batch-blame"];
const PR_ACTIONS = ["ci-run-approve", "ci-rerun"];

/**
 * The batch, its parent and children in the first wave; then the batch PR's checks, the audit rows about the batch (target
 * `repo:branch`), its members (their rows name the batch in `details.batch`) and its PR, the sandbox task and the members' items.
 */
export async function loadBatchPageData(db: Db, id: number): Promise<BatchPageData | null> {
  const page = await loadBatchPage(db, id);
  if (!page) return null;
  const b = page.batch;
  const nums = b.members.map((m) => m.number);
  const refs = nums.map((n) => ({ repo: b.repo, number: n }));
  const prRef = b.pr_number === null ? null : refOf(b.repo, b.pr_number);
  const [checks, batchRows, otherRows, tasks, items] = await db.together(() => Promise.all([
    b.pr_number === null ? null : loadChecks(db, [{ repo: b.repo, number: b.pr_number }]),
    listAudit(db, { targets: [`${b.repo}:${b.branch}`], actions: BATCH_ACTIONS }),
    listAudit(db, { targets: [...refs.map((r) => refOf(r.repo, r.number)), ...(prRef ? [prRef] : [])], actions: [...MEMBER_ACTIONS, ...PR_ACTIONS] }),
    b.task_id === null ? null : loadTasks(db, [b.task_id]),
    loadItems(db, refs, "card"),
  ]));
  const members = new Set(nums.map((n) => refOf(b.repo, n)));
  const audit = [
    ...batchRows,
    ...otherRows.filter((a) => (MEMBER_ACTIONS.includes(a.action) ? members.has(a.target ?? "") && a.details?.batch === b.branch : a.target === prRef)),
  ].sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.rowid - y.rowid));
  return { page, ci: prRef ? checks?.get(prRef) ?? null : null, audit, task: b.task_id === null ? undefined : tasks?.get(b.task_id), items };
}
