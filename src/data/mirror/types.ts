import type { Selectable } from "kysely";
import type { HiddenRepos } from "../control/types.ts";
import type { DB } from "../../db/types.ts";
import type { ItemShown } from "../../../web/src/api/types.ts";

export type { HiddenRepos, ItemShown };

/** An item key as text, `repo#number`: the key of every loader's result map. (`Ref` in `src/data/keys.ts` is the `{ repo, number }` object a key list holds.) */
export type RefKey = string;

export type ItemKind = "pr" | "issue";
export type ItemState = "OPEN" | "CLOSED" | "MERGED";

/** Columns a loader returns; a loader reads only the columns of its preset, so no loader moves `body` unless it asked. */
export type ItemPreset = "ref" | "labels" | "card" | "pr" | "text" | "full";

type ItemRowAll = Selectable<DB["items"]>;
type Pick2<K extends keyof ItemRowAll> = Pick<ItemRowAll, K>;
export type ItemRef = Pick2<"repo" | "number" | "kind" | "state">;
export type ItemLabels = ItemRef & Pick2<"url" | "labels">;
export type ItemCard = ItemRef & Pick2<"title" | "url" | "author" | "author_type" | "labels" | "assignees" | "comments_count" | "is_draft" | "created_at" | "updated_at" | "closed_at" | "merged_at" | "merged_by" | "state_reason">;
export type ItemPr = ItemRef & Pick2<"author" | "author_id" | "author_type" | "assignees" | "is_draft" | "updated_at" | "additions" | "deletions" | "head_oid" | "head_ref" | "head_repo" | "base_ref" | "mergeable" | "maintainer_can_modify" | "review_decision" | "ci_state" | "closing_issues" | "closed_at" | "merged_at">;
export type ItemText = ItemCard & Pick2<"body" | "author_id" | "author_association" | "additions" | "deletions" | "changed_files" | "closing_issues" | "text_refs" | "head_oid" | "embed_hash" | "class_hash" | "class_scheme">;
/** Every column of `items` (no `fts`). */
export type ItemFull = Omit<ItemRowAll, "jev_failed_hash">;
export type ItemOf<P extends ItemPreset> = P extends "ref" ? ItemRef : P extends "labels" ? ItemLabels : P extends "card" ? ItemCard : P extends "pr" ? ItemPr : P extends "text" ? ItemText : ItemFull;

export type OpenItemsArgs = { repos?: string[]; kind?: ItemKind; tracked?: boolean };
export type RepoItemsArgs = { repos: string[]; kind?: ItemKind };

export type ItemFilter = {
  repos?: string[]; kind?: ItemKind; states?: ItemState[]; numbers?: number[]; author?: string; labelsAny?: string[];
  /** Ranges are [from, to): `from` included, `to` excluded. `updatedSince` includes its time. */
  createdBetween?: [string, string]; updatedSince?: string; closedBetween?: [string, string]; mergedBetween?: [string, string];
  headOid?: string;
  /** Embeds the workflow scope fragment. */
  inScope?: boolean;
  hidden?: HiddenRepos;
  page?: { after: RefKey; limit: number };
};

export type PrChecksRow = Selectable<DB["pr_checks"]>;
/** A checks row whose `checks` text is null when the loader was asked to read it only for a failing PR and `overall` is not "failure". */
export type PrChecksView = Omit<PrChecksRow, "checks"> & { checks: string | null };
export type PrMirror = { item: ItemOf<"pr">; checks: PrChecksView | null };
export type OpenPrRow = { repo: string; number: number; author: string | null; closing_issues: string | null; text_refs: string | null; title?: string | null; body?: string | null };
/** PR counts of one account under a login (`author_id` null for rows mirrored before ids were stored); `repos` are the repos of those PRs. */
export type AuthorHistory = { login: string; author_id: number | null; merged: number; closed: number; open: number; lastMerge: string | null; repos: string[] };
/** `score`: lower is better. `snippets` holds the title and body snippets that contain a match. */
export type ItemHit = { ref: RefKey; score?: number; snippets?: string[] };
export type CommentHit = { ref: RefKey; id: string; author: string | null; score?: number; snippet?: string };
/** Marks around a match in a snippet. */
export type SnippetMarks = { open: string; close: string; words: number };

export type CommentRow = Selectable<DB["comments"]>;
/** A comment as a loader returns it: `body` only when the loader was asked for it. */
export type CommentOut = Omit<CommentRow, "body"> & { body?: string | null };
/**
 * `after`: created after this time. `authors`: only these logins. `excludeBots`: leaves out logins ending in "[bot]" (a comment with no
 * author stays). `order: "created"` is `created_at` ascending with nulls first, then rowid; "rowid" is insertion order.
 */
export type CommentFilter = { kinds?: string[]; counted?: boolean; after?: string; authors?: string[]; excludeBots?: boolean; order: "rowid" | "created"; body?: boolean };
/** `authors`: the distinct logins, in no set order. `length`: total body length. */
export type CommentStats = { n: number; newest: string | null; length: number; hasUrls: boolean; authors: string[] };
/** `n`: how many spoken comments the item has; `last`: the id of the newest. */
export type CommentHead = { n: number; last: string | null };
export type SpokenComment = { id: string; author: string | null; body: string };
export type ReviewFact = { id: string; author: string; association: string | null; state: string; at: string | null };

export type GateRow = Selectable<DB["review_gates"]>;
export type Gate = GateRow;
/** A successful live read; storing it resets the failure counter. */
export type GateRead = Pick<GateRow, "repo" | "number" | "blocked" | "by_login" | "read_at">;
export type DiffFactsRow = Selectable<DB["diff_facts"]>;
export type DiffFactsKey = { ref: RefKey; head: string };
export type RepoCiSignals = { known: boolean; noCi: boolean };

export type RepoRow = Selectable<DB["repos"]>;
export type RepoMeta = { name: string; owner: string; visibility?: string | null; default_branch?: string | null; open_prs?: number | null; open_issues?: number | null };
export type SyncPlan = { repos: Map<string, RepoRow>; synced: Set<string>; broken: Set<string>; /** Every repo with a failure on record. */ failing: Set<string>; state: SyncState };

/** The one `sync_state` row. */
export type SyncState = Selectable<DB["sync_state"]>;
export type SyncRunRow = Selectable<DB["sync_runs"]>;
export type SyncRequestRow = Selectable<DB["sync_requests"]>;
export type RepoFailure = { repo: string; kind: string; message: string; movedTo: string | null; at: string };
export type RepoErrorRow = Selectable<DB["sync_repo_errors"]>;

export type LivePr = {
  head: string; mergeable: string; draft: boolean; maintainerCanModify?: boolean; state?: string;
};
export type LocalPatch =
  | { kind: "merged"; repo: string; number: number; at: string }
  | { kind: "state"; repo: string; number: number; state: "CLOSED" | "MERGED"; at?: string }
  /** `stage` is the log row of the label write (`planner.addStageEvents`), written in the same transaction. */
  | { kind: "labels"; repo: string; number: number; labels: string[]; stage?: { at: string; actor: string | null; note: string | null } }
  | { kind: "base"; repo: string; number: number; baseRef: string; by?: string; head: string; keepDiff?: boolean }
  | { kind: "live"; repo: string; number: number; pr: LivePr; at: string };

export type CommentInsert = Selectable<DB["comments"]>;
/** An item row as the sync writes it: `text_refs` is set for pull requests, the hash columns are filled. */
export type ItemRowInput = ItemFull;
/** The item columns the hash functions read. */
export type HashFields = Pick<ItemFull, "repo" | "number" | "kind" | "title" | "body" | "additions" | "deletions" | "changed_files" | "author_association">;
export type ItemHashes = { embed_hash: string | null; class_hash: string | null; class_scheme: string | null };
export type ItemEntry = { repo: string; kind: ItemKind; detail: "full" | "light"; row: ItemRowInput; comments: CommentInsert[]; readAt?: string };
export type SaveItemsOptions = { readAt: string; force?: boolean; advanceOrgHighWater?: string };

/** One head of a poll with its state classified by the caller; `failing` and `checks` are JSON text. */
export type MainHead = { repo: string; sha: string; branch: string; state: string; failing: string; checks: string; committed_at: string | null; headline: string | null };
export type MainHeadRow = Selectable<DB["main_ci"]>;
/** A stored head without its check list. */
export type MainHeadSummary = Omit<MainHeadRow, "checks">;
/** `updated_at`: when the latest poll read it. */
export type LatestMainHead = { head_sha: string; state: string; committed_at: string | null; updated_at: string };

export type AuthorPermissionRow = Selectable<DB["author_permissions"]>;
export type AuthorPermissionSave = { login: string; repo: string; authorId: number | null; at: string; permission: string | null };

export type ActivityEventIn = { id: string; kind: string; at: string; actor: string | null; label: string | null; before_oid: string | null; after_oid: string | null };
export type ActivityFileIn = { path: string; additions: number; deletions: number; change_type: string };
export type ActivityCommitIn = { oid: string; committed_at: string; author: string | null; message: string | null; co_authors: string | null };
/** A finished read of one item: the item's head and update time as the due list gave them, and for a PR its files and commits at `pr.head`. */
export type ActivityRead = { repo: string; number: number; head: string | null; updatedAt: string | null; readAt: string; events: ActivityEventIn[]; pr?: { head: string; files: ActivityFileIn[]; commits: ActivityCommitIn[] } };
/** A read that found no node or failed: only the attempt is recorded, with the retry time of a failure. */
export type ActivityAttempt = { repo: string; number: number; head: string | null; updatedAt: string | null; at: string; error?: string | null; retryAt?: string | null };
export type ActivityDue = { repo: string; number: number; head: string | null; updated_at: string | null };
export type ActivityRow = Selectable<DB["item_activity"]>;
export type CommitRow = Selectable<DB["pr_commits"]>;
export type FileRow = Selectable<DB["pr_files"]>;
export type ActivityStats = { events: number; newest: string | null; commits: number; newestCommit: string | null; commitLength: number; files: number; lines: number; readAt: string | null };
export type ItemDetailPart = "item" | "comments" | "activity" | "commits" | "files" | "checks" | "read";
export type ItemDetail = { item: ItemOf<"full"> | null; comments: CommentRow[]; activity: ActivityRow[]; commits: CommitRow[]; files: FileRow[]; checks: PrChecksRow | null; read: string | null };

export type ReleaseAssetIn = {
  asset_id: number; repo: string; release_id: number; tag: string; release_name: string | null; published_at: string | null; prerelease: number;
  name: string; platform: string | null; processor: string | null; format: string | null; downloads: number;
  /** Downloads gained since the stored count (0 for a baseline or an uncounted file); the caller decides it from `loadReleaseState`. */
  delta: number;
};
/** One repo's reading with every decision made: `gone` are the stored assets GitHub no longer lists; `app` is null when no counted release is left. */
export type ReleaseReading = { repo: string; assets: ReleaseAssetIn[]; gone: number[]; app: { name: string; stars: number } | null };
export type ReleaseState = { assets: Map<number, { downloads: number; repo: string }>; lastRead: Map<string, string>; lastStars: Map<string, number> };
export type DownloadAsset = {
  asset_id: number; repo: string; tag: string; release_id: number; published_at: string | null; prerelease: number; platform: string | null; processor: string | null;
  format: string | null; downloads: number; first_seen: string; gone_at: string | null;
  /** Increases recorded in [from, end); 0 when `from` is null. */
  delta: number;
};
/** Stars of a repo: the last sample before the range start, the first sample, and the last sample before `to`. */
export type StarReadings = { atStart: number | null; first: number | null; atEnd: number | null };
export type DownloadsView = { apps: { repo: string; name: string; stars: number }[]; assets: DownloadAsset[]; stars: Map<string, StarReadings> };
/** What the image index compares to know the mirror changed. */
export type ImageSignature = { items: number; itemUpdated: string | null; comments: number };
export type ImageSource = { repo: string; body: string };
