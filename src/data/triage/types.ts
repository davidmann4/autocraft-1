import type { Selectable } from "kysely";
import type { DB } from "../../db/types.ts";
import type { RefKey } from "../mirror/types.ts";
import type { HiddenRepos } from "../control/types.ts";

export type { RefKey };

export type Level = "P0" | "P1" | "P2" | "P3" | "P4";
export type Size = "S" | "M" | "L" | "XL";

/** A `classifications` row; `flags` and `probs` are JSON text. */
export type ClsRow = { repo: string; number: number; classifier: string; run_id: string; at: string; type_label: string | null; flags: string | null; probs: string | null; reason: string | null; input_hash: string | null };
export type VerdictInput = ClsRow;
/** A verdict row of an evaluation run; the item's title and kind come from `mirror.loadItems`. */
export type RunVerdict = ClsRow;
export type JevFailed = { repo: string; number: number; hash: string };
export type SettledStatus = "settled" | "waiting" | "disagree" | "unclassified";
export type Referee = { label: string; sure: boolean; reason: string; final?: boolean; failures?: number; failedAt?: string };
export type Settled = {
  status: SettledStatus; label: string | null; source: "jev" | "haiku" | "sonnet" | null; confidence: number | null;
  jevLabel: string | null; haikuLabel: string | null; flags: string[]; referee: Referee | null;
};
export type RefereeRow = { at: string; type_label: string | null; reason: string | null; probs: string | null };
export type ClassifierDuplicates = { of: number[]; by: number[] };

/** `score` is the reach; `savePriorities` writes it only on insert, `rescoreReach` owns it after. */
export type PriorityRow = { repo: string; number: number; impact: Level; textHash: string; jevImpact: Level | null; jevP: number | null; haikuImpact: Level | null; score: number; model: string; reason: string | null; at: string };
export type RankBreakdown = { level: Level; rated: Level | null; security: boolean; type: string | null; size: Size; sizeSource: "lines" | "triage" | "default"; reach: number };
export type RankRow = { score: number; breakdown: RankBreakdown; computedAt: string };
/** An open tracked item with its stored level and reach (null before it was rated) and, for a PR, its changed lines. */
export type RankItemRow = { repo: string; number: number; kind: string; lines: number | null; level: Level | null; reach: number | null };
/** What `loadRankInputs` returns: the items to rank, their settled verdicts (absent: unclassified) and the stored ranks. */
export type RankInputs = { items: RankItemRow[]; settled: Map<RefKey, Settled>; old: Map<RefKey, { score: number; breakdown: RankBreakdown }> };
export type RankPut = { repo: string; number: number; score: number; breakdown: RankBreakdown; computedAt: string };

export type Area = { name: string; description: string };
export type AreaList = { repo: string; version: number; areas: Area[]; at: string; by: string | null; note: string | null };
export type AreaVersion = Omit<AreaList, "repo">;
export type ItemArea = { area: string | null; source: string; confidence: number | null; listVersion: number; at: string };
export type ItemAreaPut = { repo: string; number: number; area: string | null; source: string; confidence: number | null };
export type AreaOverview = { list: AreaList | null; counts: Map<string, number>; unassigned: number; proposals: AreaProposal[] };
/** An open item due an area answer, as the area prompts see it, with the version of the list it is asked against. */
export type AreaDue = {
  repo: string; number: number; kind: "pr" | "issue"; title: string; body: string; lines_changed: number | null; files_changed: number | null;
  author_association: string | null; head: string | null; version: number;
};
/** A repo's current list as an area question asks it. */
export type AskedList = { areas: Area[]; version: number };
export type AreaEdit =
  | { op: "add"; name: string; description: string }
  | { op: "rename"; from: string; to: string }
  | { op: "merge"; from: string; into: string }
  | { op: "remove"; name: string }
  | { op: "describe"; name: string; description: string }
  | { op: "replace"; areas: Area[] };
export type ProposalArea = Area & { state: "open" | "accepted" | "ignored" };
export type AreaProposal = {
  id: number; repo: string; kind: "propose" | "suggest"; areas: ProposalArea[]; createdAt: string; createdBy: string | null;
  state: "open" | "accepted" | "dismissed"; decidedBy: string | null; decidedAt: string | null;
};
export type SampleItem = { repo: string; number: number; title: string; body: string };

export type EmbeddingPut = { repo: string; number: number; model: string; hash: string; vec: Uint8Array };
export type EmbedDiffRow = { repo: string; number: number; hash: string | null };
export type EmbeddingMark = { rows: number; maxRowid: number | null; tracked: string };
export type StreamedEmbedding = { rid: number; repo: string; number: number; vec: Uint8Array };

export type Pair = { repo: string; a: number; b: number; a_hash: string; b_hash: string; similarity: number };
export type PairKey = Pair;
export type PairVerdictPut = { repo: string; a: number; b: number; a_hash: string; b_hash: string; jev_p: number | null; haiku: string | null; verdict: string; canonical: number | null; checked_at: string };
/** Pairs an operator ruled on, the stored scan hash per item and the stored pairs (`pairKey`) among the refs asked for. */
export type ScanContext = { operatorPairs: Pair[]; scans: Map<RefKey, string>; stored: Set<string> };
export type CanonInfo = { state: string; created_at: string | null; comments_count: number | null; fixedBy: RefKey | null };
/** A stored comparison of one kind set; `sizes` and `heads` (PR sets only) are the snapshot the comparison read, by member number. */
export type ComparisonPut = {
  repo: string; key: string; kind: "pr" | "issue"; members: number[]; hash: string; kept: number; source: string; model: string | null; reason: string | null;
  result: unknown | null; error: string | null; attempts: number; at: string; summary: string | null; why: string | null;
  sizes: Record<number, number> | null; heads: Record<number, string> | null;
};
export type DupeEdge = { repo: string; a: number; b: number; similarity: number; jev_p: number | null; haiku: string | null };
/**
 * A member of a duplicate edge with the columns the set logic reads; `in_scope` is the workflow scope of the item, `started` whether
 * a live workflow works on it, `ruled` the higher-numbered items a person ruled on as its pair (comma-joined, null for none).
 */
export type DupeMember = {
  repo: string; number: number; kind: "pr" | "issue"; state: string; title: string | null; head_oid: string | null; embed_hash: string | null;
  comments_count: number | null; additions: number | null; deletions: number | null; closing_issues: string | null; state_reason: string | null; in_scope: boolean; started: boolean; ruled: string | null;
};
/** `comparisons` and `drops` are keyed `repo\nkey`. */
export type DupeState = { edges: DupeEdge[]; members: Map<RefKey, DupeMember>; comparisons: Map<string, Selectable<DB["dupe_comparisons"]>>; drops: Map<string, { hash: string; at: string }> };
/**
 * The open or merged PRs an open PR duplicates (ascending numbers), by the settled answers: the group's comparison, or the checked
 * pairs while the group has none (`compared` false).
 */
export type PrDuplicates = { of: number[]; compared: boolean };
export type DupeGroupPut = { id: string; repo: string; source: string; items: { number: number; kind: string; role: string; target: number | null; detail: string | null }[] };
export type DupeSignal = { groupId: string; role: "keep" | "close" | "stay"; target: number | null; reason: string | null };

export type TriageFacts = {
  score: number | null;
  priority: { impact: Level; hash: string | null } | null;
  embeddedHash: string | null;
  scannedHash: string | null;
  jevFailedHash: string | null;
  verdicts: ClsRow[];
  pairsToCheck: number;
  compare: "rule" | "model" | null;
};
/** `dupes`: the duplicate state, when the caller's other loads read it too. */
export type TriageFactsCtx = { model: string; run: string | null; nowMs: number; dupes?: (() => Promise<DupeState>) | undefined };
export type TriageFactsResult = { facts: Map<RefKey, TriageFacts>; compareDueAt: Map<RefKey, number> };

/** One run of verdicts: its classifier pairs with the items both rated, the classifier with probabilities first. */
export type ClassifierRun = { id: string; at: string; pairs: { a: string; b: string; items: number }[] };
/** One item rated by both classifiers of the chosen pair; `kind` is null when the item left the mirror. */
export type ClassifierPairRow = { repo: string; kind: string | null; ta: string | null; tb: string | null; pa: number | null; fa: string | null; fb: string | null };
/** `run`, `a` and `b` name the chosen run and pair (the newest run and its first pair when absent or unknown); `rows` are that pair's items. */
export type ClassifierReport = { runs: ClassifierRun[]; run: string; a: string; b: string; rows: ClassifierPairRow[] };
export type ClassifierReportFilter = { run?: string; a?: string; b?: string; hidden: HiddenRepos };
export type DisagreementFilter = {
  run: string; a: string; b: string; label?: string; band?: { lo: number; hi: number }; hidden: HiddenRepos; limit: number; offset: number;
};
export type Disagreement = { repo: string; number: number; a: { label: string; prob: number | null }; b: { label: string; prob: number | null } };
export type DisagreementList = { total: number; rows: Disagreement[] };
export type ItemTriage = { verdicts: ClsRow[]; settled: Settled | null; priority: PriorityRow | null; area: ItemArea | null; rank: RankRow | null; dupe: DupeSignal | null };
