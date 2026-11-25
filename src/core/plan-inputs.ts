// Every table the planner's fact loaders (loadPrFacts, loadItemFacts and the set readers they call) read, and what a change
// to a row there means for the plans: which items it re-decides, or that every item must be decided again. The change log
// (src/core/plan-changes.ts) generates its triggers from this list. Taken from the SQL the loaders prepare during a full load
// (test/plan-changes.test.ts checks that every table they read is listed).
//
// SQL fragments name the written row `r` (`r.repo`); the triggers put `new` or `old` in its place. Subqueries must not use the
// alias `r` themselves.
import { BOOKKEEPING_SETTINGS } from "../live.ts";
import { PERM_READ_TTL } from "../dash/server/sessions.ts";
import { pgExpr, pgJsonArray } from "./pg-expr.ts";

/**
 * - item: a row belongs to one item; a change re-decides that item.
 * - cross: a row changes facts of several items, or of items it does not name; the trigger logs every affected item, or forces
 *   a full pass where that set is not readable with a simple subquery.
 * - global: settings, repo-level rows, roles and breakers; a change forces a full pass.
 * - none: read, but not as a fact input (a memo key); no trigger.
 */
export type PlanInputClass = "item" | "cross" | "global" | "none";

export type PlanInput = {
  table: string;
  class: PlanInputClass;
  why: string;
  /** SELECT of the `repo` and `number` columns of the items row `r` decides; an item input defaults to the row's own repo and number, a cross input without it only forces full passes. */
  refs?: string;
  /** Condition on `r`: only rows that meet it are logged. */
  when?: string;
  /** An UPDATE counts only when one of these columns changed (default: every column but the bookkeeping ones, src/live.ts). */
  columns?: string[];
  /** Condition on `old` and `new` that replaces the changed-columns check of an UPDATE. */
  updateWhen?: string;
  /** Condition on `r` that forces a full pass: on INSERT and DELETE of such a row, and on an UPDATE that counts where either row meets it. */
  full?: string;
  /** Condition on `old` and `new` that forces a full pass on UPDATE, instead of `full`; it is checked on its own, without the changed-columns check. */
  fullUpdate?: string;
  /**
   * Postgres forms of the fragments above, for those the mechanical rewrite (pgExpr in src/core/plan-changes.ts) cannot
   * translate: JSON functions, GLOB, integer results used as conditions.
   */
  pg?: Partial<Record<"refs" | "when" | "updateWhen" | "full" | "fullUpdate", string>>;
};

/** Live states of item_workflows (src/workflow/store.ts LIVE_STATES). */
const WF_LIVE = "('running', 'waiting', 'blocked', 'recommending')";

/** The PR number at the end of a pull request URL (`fastScoreSql` and `pilotSqlFor` link a fix attempt to its PR this way), else NULL. */
const prOfUrl = (url: string): string => `CASE WHEN instr(${url}, '/pull/') > 0 THEN CAST(substr(${url}, instr(${url}, '/pull/') + 6) AS INTEGER) END`;

/** Integration PRs of the checking or open batches that carry PR `number` of `repo` (their scope and CI tip read the members). */
const batchPrsOf = (repo: string, number: string): string =>
  `SELECT b.repo AS repo, b.pr_number AS number FROM merge_batches b JOIN merge_batch_prs bp ON bp.batch_id = b.id
    WHERE b.repo = ${repo} AND bp.number = ${number} AND b.state IN ('checking', 'open') AND b.pr_number IS NOT NULL`;

/** PRs with a hold review that names `repo#number` as a blocking item (src/review/blockers.ts), through review_blockers (src/core/plan-changes.ts). */
const blockedBy = (repo: string, number: string): string =>
  `SELECT o.repo AS repo, o.number AS number FROM review_blockers rb JOIN opus_reviews o ON o.repo = rb.repo AND o.number = rb.number AND o.head_oid = rb.head_oid
    WHERE rb.b_repo = ${repo} AND rb.b_number = ${number} AND o.verdict = 'hold'`;

/** Members of the duplicate group decision `id`. */
const groupMembers = (id: string): string => `SELECT gm.repo AS repo, gm.number AS number FROM dupe_group_items gm WHERE gm.decision_id = ${id}`;

/** PRs a queued or pushed carry-over of decision `id` works on (their carry facts read the group's close-role members). */
const carriesOf = (id: string): string => `SELECT dc.repo AS repo, dc.number AS number FROM dupe_carries dc WHERE dc.decision_id = ${id}`;

/** True when item `a` is in a duplicate edge or group: its state, text and activity move other members' sets, groups and canonical pick (src/dupes/plan.ts). */
// The unary + keeps SQLite off the verdict index: the item's own pairs are a key lookup.
const inDupeSet = (a: string): string =>
  `(EXISTS (SELECT 1 FROM duplicate_pairs dp WHERE dp.repo = ${a}.repo AND dp.a = ${a}.number AND +dp.verdict = 'duplicate')
    OR EXISTS (SELECT 1 FROM duplicate_pairs dp WHERE dp.repo = ${a}.repo AND dp.b = ${a}.number AND +dp.verdict = 'duplicate')
    OR EXISTS (SELECT 1 FROM dupe_group_items dg WHERE dg.repo = ${a}.repo AND dg.number = ${a}.number))`;

const changed = (cols: string[]): string => cols.map((c) => `old.${c} IS NOT new.${c}`).join(" OR ");

/** A pilot list is set: a fix attempt's link then moves its PR's scope, and with it duplicate sets and integration PRs. */
const PILOT_LIST_SET = `COALESCE((SELECT json_array_length(CASE WHEN json_valid(ps.value) THEN ps.value ELSE '[]' END) FROM settings ps WHERE ps.key = 'pilot_items'), 0) > 0`;
const PILOT_LIST_SET_PG = `COALESCE((SELECT json_array_length(${pgJsonArray("ps.value")}) FROM settings ps WHERE ps.key = 'pilot_items'), 0) > 0`;

/**
 * Item columns that change other PRs' facts: stacked PRs (head_ref, head_repo), long-lived branches (base_ref, author_association),
 * authors' tiers (state). A PR's text and closing links move issues' open PR, which the PR_REFS input logs by issue.
 */
const PR_CROSS_COLUMNS = ["state", "head_ref", "head_repo", "base_ref", "author_association"];

/**
 * A PR's text edit whose earlier references are not stored: the issues it named are not readable, so every item is decided again.
 * Only sync writes title and body, and it writes text_refs in the same transaction (src/mirror.ts), so the new references are logged.
 */
const PR_TEXT_UNKNOWN = "(new.kind = 'pr' AND old.text_refs IS NULL AND (old.title IS NOT new.title OR old.body IS NOT new.body))";

/** The issues a PR's stored text references (text_refs mentions, which include the closing ones) and closing-issue links name. */
const PR_REFS = `SELECT r.repo AS repo, j.value AS number FROM json_each(CASE WHEN json_valid(r.text_refs) AND json_type(r.text_refs, '$[1]') = 'array' THEN json_extract(r.text_refs, '$[1]') ELSE '[]' END) j WHERE j.type = 'integer'
      UNION SELECT r.repo, j.value FROM json_each(CASE WHEN json_valid(r.closing_issues) AND json_type(r.closing_issues) = 'array' THEN r.closing_issues ELSE '[]' END) j WHERE j.type = 'integer'`;
const pgRefsArray = (x: string): string => `COALESCE(CASE WHEN json_valid(${x}) THEN CASE WHEN json_typeof(${x}::json -> 1) = 'array' THEN ${x}::json -> 1 END END, '[]'::json)`;
const PR_REFS_PG = `SELECT r.repo AS repo, ac_int(j #>> '{}') AS number FROM json_array_elements(${pgRefsArray("r.text_refs")}) j WHERE json_typeof(j) = 'number'
      UNION SELECT r.repo, ac_int(j #>> '{}') FROM json_array_elements(${pgJsonArray("r.closing_issues")}) j WHERE json_typeof(j) = 'number'`;
/** Item columns that change duplicate sets, group plans and the canonical pick of the item's group. */
const DUPE_COLUMNS = ["state", "title", "body", "embed_hash", "comments_count", "created_at", "closing_issues"];

/** An item write that forces a full pass; `no` is the dialect's false (the CASE keeps SQLite from probing the dupe tables on every write). */
const itemsFullUpdate = (no: string): string => `${changed(["kind", "author", "author_id"])}
      OR (new.kind = 'pr' AND (${changed(PR_CROSS_COLUMNS)})) OR ${PR_TEXT_UNKNOWN}
      OR (CASE WHEN ${changed(DUPE_COLUMNS)} THEN ${inDupeSet("new")} ELSE ${no} END)`;

/**
 * Settings rows the runner, sync and planner write for their own use (src/live.ts), less `classify_run`, which picks the run every
 * item's labels come from; the planner's shadow switch; and the app installation sweep's time. No fact reads these.
 */
export const PLAN_IGNORED_SETTINGS = [...BOOKKEEPING_SETTINGS.filter((k) => k !== "classify_run"), "plan_shadow", "app_install_sweep_at"];
// Leader and standby status rows (src/db/leader.ts) are rewritten every few seconds and warm sizes after every warm build;
// no fact loader reads them. The build feature switches are read (featureOn), so they stay inputs.
const PLAN_IGNORED_SETTING_LIKE = ["%\\_points\\_last\\_run", "pipeline\\_fp:%", "leader:%", "warm\\_bytes:%"];

/**
 * A repo_permissions UPDATE that moves facts: a new login, repo or permission, or a checked_at refresh of a row that was no longer
 * fresh. Settlers read a write permission as fresh while checked_at is younger than PERM_READ_TTL (src/settlers.ts), and the
 * pipeline and dashboard sessions refresh it before then (src/preapproval/permissions.ts), so a refresh of a fresh row changes no
 * fact. The threshold is a minute stricter than PERM_READ_TTL, for clock skew between the database and the planner.
 */
const FRESH_S = Math.round(PERM_READ_TTL / 1000) - 60;
const permissionMoved = (fresh: string): string => `${changed(["login", "repo", "permission"])} OR NOT (old.checked_at > ${fresh})`;
const PERMISSION_FULL_UPDATE = permissionMoved(`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${FRESH_S} seconds')`);
const PERMISSION_FULL_UPDATE_PG = permissionMoved(`to_char(now() AT TIME ZONE 'UTC' - interval '${FRESH_S} seconds', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`)
  .replace(/ IS NOT /g, " IS DISTINCT FROM ");

export const PLAN_INPUTS: PlanInput[] = [
  // ---- item-keyed ----
  // A bookkeeping column (src/live.ts) that the Plan reads: it is watched here on its own.
  { table: "items", class: "item", why: "A classify request that gave no valid verdict at the item's input (jev_failed_hash) ends the prioritize hold.", columns: ["jev_failed_hash"] },
  { table: "actions", class: "item", why: "Act's comment-and-close record of one item (answeredClose)." },
  { table: "agent_run_items", class: "item", why: "Links a model run to an item; the review gate counts the item's Opus review runs." },
  { table: "ci_fixes", class: "item", why: "CI fix rows of one PR (cifix facts, push chain, lint)." },
  { table: "ci_run_approvals", class: "item", why: "Workflow runs waiting at one PR head; an integration PR's tip rows are its own." },
  {
    table: "classifications", class: "item", why: "Classifier verdicts of one item.",
    // Without a classify_run setting the run every item's labels come from is the newest verdict run (latestRun).
    full: "NOT EXISTS (SELECT 1 FROM settings cs WHERE cs.key = 'classify_run' AND COALESCE(cs.value, '') <> '')",
  },
  { table: "comments", class: "item", why: "Comments and reviews of one item (discussion state, review gate, decision prepares)." },
  { table: "conflict_merges", class: "item", why: "Conflict merges of one PR (conflict bucket, push chain, lint)." },
  {
    table: "decision_prepares", class: "item", why: "Prepare stamps of one decision: its item's recommend facts.",
    refs: "SELECT d.repo AS repo, d.number AS number FROM decisions d WHERE d.id = r.decision_id",
  },
  {
    table: "decision_choices", class: "item", why: "Choices of a decision, checked against its item's head.",
    refs: "SELECT r.repo AS repo, r.number AS number UNION SELECT d.repo, d.number FROM decisions d WHERE d.id = r.decision_id",
    columns: ["decision_id", "repo", "number", "state", "seen", "drafts", "added"],
  },
  { table: "diff_facts", class: "item", why: "What the merge rule reads from one PR head's cached diff (sensitive reasons, changed lines, pending re-reads)." },
  { table: "dupe_carries", class: "item", why: "Carry-overs onto one PR." },
  { table: "duplicate_scans", class: "item", why: "The text hash one item was scanned at." },
  { table: "fixups", class: "item", why: "Fix-up rows of one PR (fix-up, operator fix-up, lint, push chain)." },
  { table: "item_embeddings", class: "item", why: "One item's embedding hash.", columns: ["repo", "number", "model", "hash"] },
  {
    table: "item_plans", class: "item", why: "The item's own planned review or carry: its open decisions' prepare waits for it (reviewQueuedSql). The planner writes it; an unchanged plan writes nothing.",
    // Only an item with an open decision reads it; opening a decision logs the item through the decisions input.
    refs: "SELECT r.repo AS repo, r.number AS number WHERE EXISTS (SELECT 1 FROM decisions d WHERE d.repo = r.repo AND d.number = r.number AND d.answer IS NULL)",
    columns: ["actions"],
  },
  { table: "item_priority", class: "item", why: "One item's priority row." },
  { table: "item_rank", class: "item", why: "One item's fast-track score input." },
  { table: "item_stage", class: "item", why: "One item's stage row." },
  { table: "merge_holds", class: "item", why: "An operator's merge hold on one PR." },
  { table: "merges", class: "item", why: "Merge attempts of one PR." },
  { table: "operator_fixups", class: "item", why: "An operator's fix-up request on one PR." },
  { table: "opus_review_history", class: "item", why: "Overwritten reviews of one PR (unsure heads, review counts)." },
  { table: "postmerge_reviews", class: "item", why: "The post-merge review of one PR." },
  { table: "preapprovals", class: "item", why: "A pre-approved merge of one PR." },
  { table: "premerge_reviews", class: "item", why: "Pre-merge reviews of one PR." },
  { table: "push_outcomes", class: "item", why: "Our pushes to one PR (pushed heads, broken heads)." },
  { table: "review_gates", class: "item", why: "The changes-requested gate of one PR." },
  { table: "review_posts", class: "item", why: "Our posted review on one PR." },
  { table: "stages", class: "item", why: "One item's labeled note.", when: "r.stage = 'labeled'" },
  { table: "verifications", class: "item", why: "Verification runs of one PR." },
  {
    table: "audit", class: "item", why: "Assign and unassign of an item, and Retry or answer of a Merge? decision, whose target names the item.",
    when: "r.action IN ('assign', 'unassign', 'retry', 'answer') AND instr(r.target, '#') > 1",
    refs: "SELECT substr(r.target, 1, instr(r.target, '#') - 1) AS repo, CAST(substr(r.target, instr(r.target, '#') + 1) AS INTEGER) AS number",
  },

  // ---- cross-item ----
  {
    table: "items", class: "cross", why: "One item's mirror row; a new or deleted item, a PR's state, text or branches, an author, or a change to a member of a duplicate set changes other items' facts.",
    refs: "SELECT r.repo AS repo, r.number AS number",
    full: "r.kind = 'pr'",
    fullUpdate: itemsFullUpdate("0"),
    pg: { fullUpdate: pgExpr(itemsFullUpdate("false")) },
  },
  {
    table: "items", class: "cross", why: "An item's state or text hash: the other item of its unchecked duplicate pairs (pairs to check).",
    updateWhen: changed(["state", "kind", "embed_hash"]),
    refs: `SELECT dp.repo AS repo, dp.b AS number FROM duplicate_pairs dp WHERE dp.repo = r.repo AND dp.a = r.number AND +dp.verdict IS NULL
      UNION SELECT dp.repo, dp.a FROM duplicate_pairs dp WHERE dp.repo = r.repo AND dp.b = r.number AND +dp.verdict IS NULL`,
  },
  {
    // Old and new rows both: the issues the earlier text named and those the new text names. Sync clears text_refs when the text
    // changes (schema trigger items_text_refs_stale) and writes the new references after the row.
    table: "items", class: "cross", why: "A PR's text references and closing links: the issues it closes or mentions (issues' open PR).",
    when: "r.kind = 'pr'",
    updateWhen: changed(["title", "body", "closing_issues", "text_refs"]),
    refs: PR_REFS,
    pg: { refs: PR_REFS_PG, updateWhen: pgExpr(changed(["title", "body", "closing_issues", "text_refs"])) },
  },
  {
    table: "items", class: "cross", why: "An item's state: PRs held for it as a blocking item.",
    updateWhen: changed(["state", "kind"]),
    refs: blockedBy("r.repo", "r.number"),
  },
  {
    table: "decisions", class: "cross", why: "A decision is about its item, the items of its list, its group's members or a pair's two items; carry-overs of a group and PRs held for a blocking item read it too.",
    refs: `SELECT r.repo AS repo, r.number AS number
      UNION SELECT json_extract(dj.value, '$.repo'), json_extract(dj.value, '$.number') FROM json_each(CASE WHEN json_valid(r.items) THEN CASE WHEN json_type(r.items) = 'array' THEN r.items ELSE '[]' END ELSE '[]' END) dj WHERE dj.type = 'object'
      UNION ${groupMembers("r.id")}
      UNION SELECT r.repo, CAST(substr(r.id, instr(r.id, '@') + 1) AS INTEGER) WHERE r.kind = 'duplicate' AND r.id NOT LIKE '%:dupegroup:%' AND r.id GLOB '*@[0-9]*'
      UNION ${carriesOf("r.id")}
      UNION ${blockedBy("r.repo", "r.number")}`,
    pg: {
      refs: `SELECT r.repo AS repo, r.number AS number
      UNION SELECT dj ->> 'repo', ac_int(dj ->> 'number') FROM json_array_elements(${pgJsonArray("r.items")}) dj WHERE json_typeof(dj) = 'object'
      UNION ${groupMembers("r.id")}
      UNION SELECT r.repo, ac_int(substr(r.id, instr(r.id, '@') + 1)) WHERE r.kind = 'duplicate' AND r.id NOT LIKE '%:dupegroup:%' AND r.id ~ '@[0-9]'
      UNION ${carriesOf("r.id")}
      UNION ${blockedBy("r.repo", "r.number")}`,
    },
  },
  {
    table: "opus_reviews", class: "cross", why: "The latest review of one PR; integration PRs carrying it check their members' reviews, and PRs held for it as a blocking item read its verdict.",
    refs: `SELECT r.repo AS repo, r.number AS number UNION ${batchPrsOf("r.repo", "r.number")} UNION ${blockedBy("r.repo", "r.number")}`,
  },
  {
    table: "merge_batches", class: "cross", why: "A batch: its integration PR and every member (batch states, active batch, integration scope and tip).",
    refs: "SELECT r.repo AS repo, r.pr_number AS number UNION SELECT r.repo, bp.number FROM merge_batch_prs bp WHERE bp.batch_id = r.id",
  },
  {
    table: "merge_batch_prs", class: "cross", why: "A batch member: the member PR and the batch's integration PR.",
    refs: "SELECT b.repo AS repo, r.number AS number FROM merge_batches b WHERE b.id = r.batch_id UNION SELECT b.repo, b.pr_number FROM merge_batches b WHERE b.id = r.batch_id",
  },
  {
    table: "dupe_group_items", class: "cross", why: "A group member's role: every member of the group (held, group to ask, closers) and the group's carry-overs.",
    refs: `SELECT r.repo AS repo, r.number AS number UNION ${groupMembers("r.decision_id")} UNION ${carriesOf("r.decision_id")}`,
  },
  { table: "dupe_groups", class: "cross", why: "A group's applied answer: every member (closers).", refs: groupMembers("r.decision_id") },
  { table: "dupe_group_posts", class: "cross", why: "A group's close records: every member (closers).", refs: groupMembers("r.decision_id") },
  {
    table: "duplicate_pairs", class: "cross", why: "A pair: both items (pairs to check); a duplicate edge changes the sets and groups of its whole component.",
    refs: "SELECT r.repo AS repo, r.a AS number UNION SELECT r.repo, r.b",
    full: "r.verdict = 'duplicate'",
  },
  { table: "dupe_comparisons", class: "cross", why: "A compared set: the group plans of every member of the set's group, which the row does not name.", full: "1" },
  {
    table: "fix_attempts", class: "cross", why: "A fix attempt: its issue and the PR it opened (fast-track score, own PRs, unmirrored PR); with a pilot list, the PR's scope moves duplicate sets and integration PRs.",
    refs: `SELECT r.repo AS repo, r.number AS number UNION SELECT r.repo, ${prOfUrl("r.pr_url")}`,
    full: `r.pr_url IS NOT NULL AND ${PILOT_LIST_SET}`,
    pg: { full: `r.pr_url IS NOT NULL AND ${PILOT_LIST_SET_PG}` },
  },
  {
    // Refs, not a full pass: the rows a change can move are this issue's, its PR's and, through the repo's live count, the repo's other queued issues.
    table: "implementations", class: "cross", why: "An implementation attempt: its issue, its PR (which it revises), and the repo's other open queued issues (live implementations per repo bound new attempts).",
    refs: `SELECT r.repo AS repo, r.number AS number
      UNION SELECT r.repo, r.pr_number WHERE r.pr_number IS NOT NULL
      UNION SELECT f.repo, f.number FROM fast_track f JOIN items fi ON fi.repo = f.repo AND fi.number = f.number WHERE f.repo = r.repo AND fi.state = 'OPEN' AND fi.kind = 'issue'`,
  },
  {
    table: "implementation_rounds", class: "cross", why: "A round of an implementation: its issue (a question round sets who the attempt waits on and from when) and its PR (a revise round says which head was revised).",
    refs: "SELECT m.repo AS repo, m.number AS number FROM implementations m WHERE m.id = r.implementation_id UNION SELECT m.repo, m.pr_number FROM implementations m WHERE m.id = r.implementation_id AND m.pr_number IS NOT NULL",
  },
  {
    table: "build_tasks", class: "cross", why: "A sandbox task's state: its item, and the fix attempt, fix-up, CI fix or conflict merge whose task it is.",
    columns: ["state", "repo", "number"],
    refs: `SELECT r.repo AS repo, r.number AS number
      UNION SELECT fa.repo, fa.number FROM fix_attempts fa WHERE fa.head_task_id = r.id OR fa.base_task_id = r.id
      UNION SELECT f.repo, f.number FROM fixups f WHERE f.lint_task = r.id
      UNION SELECT c.repo, c.number FROM ci_fixes c WHERE c.lint_task = r.id OR c.task_id = r.id
      UNION SELECT m.repo, m.number FROM conflict_merges m WHERE m.lint_task = r.id`,
  },
  {
    table: "agent_runs", class: "cross", why: "An Opus review run's start: the items it ran for (review counts of the review gate).",
    when: "r.step = 'opus-review'", columns: ["step", "started_at", "job_id"],
    refs: "SELECT ai.repo AS repo, ai.number AS number FROM agent_run_items ai WHERE ai.run_id = r.id",
  },
  {
    table: "conversation_cards", class: "cross", why: "A queued or running card locks the decision it settles (lockLiveExpr), named by the decision's exec_reason.",
    columns: ["state", "acted_at"],
    // 'settling' is SETTLING in src/answers/hold.ts.
    refs: "SELECT d.repo AS repo, d.number AS number FROM decisions d WHERE d.exec_state = 'settling' AND d.exec_reason LIKE r.id || ':%'",
  },
  {
    table: "author_permissions", class: "cross", why: "An author's write permission on a repo: every open PR of that author there (pushable).",
    refs: "SELECT ap.repo AS repo, ap.number AS number FROM items ap WHERE ap.author = r.login AND ap.repo = r.repo AND ap.kind = 'pr' AND ap.state = 'OPEN'",
  },
  {
    table: "pr_checks", class: "cross", why: "Checks of one PR; a new row or one whose overall state moves to or from none can flip its repo's no-CI fact (reposWithNoCi).",
    refs: "SELECT r.repo AS repo, r.number AS number",
    full: "1", fullUpdate: "(COALESCE(old.overall, 'none') = 'none') IS NOT (COALESCE(new.overall, 'none') = 'none')",
  },
  {
    // Commands move a workflow at human pace; its recommendation, plan parts and blocker are not planner facts.
    table: "item_workflows", class: "cross", why: "A maintainer workflow: its item's entry and approval, the PR of an issue's implement workflow, and, when it starts or ends, the item's scope (duplicate sets, integration PRs).",
    columns: ["repo", "number", "entry", "state", "approved_by", "started_by", "started_at"],
    refs: "SELECT r.repo AS repo, r.number AS number UNION SELECT wi.repo, wi.pr_number FROM implementations wi WHERE wi.repo = r.repo AND wi.number = r.number AND wi.pr_number IS NOT NULL",
    full: `r.state IN ${WF_LIVE}`,
    fullUpdate: `(old.state IN ${WF_LIVE}) IS NOT (new.state IN ${WF_LIVE})`,
  },
  { table: "fast_track", class: "cross", why: "Fast track moves an item's scope and score, its fix PR's, and through scope its duplicate sets and integration PRs.", full: "1" },
  { table: "outside_holds", class: "cross", why: "An outside-author hold moves an item's scope, and through it duplicate sets, fix PRs and integration PRs.", full: "1" },
  { table: "postmerge_followups", class: "cross", why: "A follow-up links a merged PR in the pilot list to the fix PR of its issue (scope).", full: "1" },
  {
    table: "security_findings", class: "cross", why: "A finding's quiet fix PR: that PR's scope, labels and own-PR facts, and through scope its duplicate sets.",
    columns: ["repo", "number", "state", "fork", "fix_pr"], full: "1",
  },
  { table: "security_quiet_prs", class: "cross", why: "A former quiet PR of a finding (scope, labels).", full: "1" },

  // ---- global ----
  { table: "settings", class: "global", why: "Approvals, pilot list, pipeline switch and login, app slugs, classification run, optional checks and the other switches every item reads.",
    when: `r.key NOT IN (${PLAN_IGNORED_SETTINGS.map((k) => `'${k}'`).join(", ")})${PLAN_IGNORED_SETTING_LIKE.map((l) => ` AND r.key NOT LIKE '${l}' ESCAPE '\\'`).join("")}` },
  { table: "tracked_repos", class: "global", why: "Tracked repos and their pipeline switch (scope of every item)." },
  { table: "repos", class: "global", why: "Visibility and default branch of a repo (every PR there).", columns: ["name", "visibility", "default_branch", "owner"] },
  { table: "access", class: "global", why: "Operator and maintainer roles: who settles a decision, whose comments count." },
  {
    table: "repo_permissions", class: "global", why: "Maintainers' write permission per repo: who settles decisions there.",
    fullUpdate: PERMISSION_FULL_UPDATE, pg: { fullUpdate: PERMISSION_FULL_UPDATE_PG },
  },
  { table: "author_ids", class: "global", why: "Author logins bound to account ids: tiers of every PR of the author." },
  { table: "whitelist_overrides", class: "global", why: "Operator tier overrides of an author." },
  { table: "stage_trips", class: "global", why: "Tripped breakers, per stage and repo (a fact of every item of the repo, like main_ci); trips are rare, so a full pass costs little." },
  {
    table: "main_ci", class: "global", why: "Default-branch CI per repo (red main).",
    // Not `checks`: the full list moves with every check of a running head, and only the dashboard reads it.
    columns: ["repo", "head_sha", "branch", "state", "failing", "committed_at", "headline", "first_seen_at", "state_changed_at"],
  },
  { table: "main_fixes", class: "global", why: "Fixes of a red default branch: the repo's main CI state and its own fix PR." },
  { table: "own_commits", class: "global", why: "Commits the pipeline pushed: whether a PR's head is its own work, through any push chain." },
  { table: "owner_statements", class: "global", why: "Owner statements that stored reviews of any PR name as conflicts." },

  // ---- read, but not a fact input ----
  { table: "change_seq", class: "none", why: "Topic counters: the memo key of the discussion state (src/review/discussion.ts), whose inputs are logged themselves." },
];
