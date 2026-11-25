// Change markers: one counter per topic in `change_seq`, bumped by triggers on the
// tables the dashboard reads. Triggers fire for writes from every process (runner,
// sync, sandbox worker, dashboard), so no code path can forget to signal.
import type { DatabaseSync } from "node:sqlite";
import { GITHUB_ACTIONS } from "./github/actions.ts";
import type { Db } from "./db/index.ts";

type Source = { table: string; ops?: ("INSERT" | "UPDATE" | "DELETE")[]; when?: string };

/**
 * Columns that move without a change to what a page shows: fetch and compute times, content hashes
 * derived from other columns, and flags the runner flips for its own use. An UPDATE that changes only
 * these bumps nothing. Every other column of a table is compared (see liveSql).
 */
export const BOOKKEEPING_COLUMNS: Record<string, string[]> = {
  workspaces: ["updated_at", "last_call_at", "next_call", "create_tries", "pod_created_at"],
  repos: ["synced_at", "high_water", "reconciled_at"],
  items: ["embed_hash", "class_hash", "class_scheme", "text_refs", "jev_failed_hash"],
  classifications: ["at", "input_hash"],
  pr_checks: ["fetched_at"],
  main_ci: ["updated_at"],
  release_assets: ["updated_at"],
  release_apps: ["updated_at"],
  ci_run_approvals: ["checked_at"],
  item_priority: ["at"],
  item_rank: ["computed_at"],
  flow_summary: ["counted_at", "stale", "decisions_sig"],
  duplicate_scans: ["at"],
  item_plans: ["planned_at"],
  lane_next: ["at"],
  decisions: ["snoozed_by", "snoozed_at"],
  item_workflows: ["updated_at"],
};

/** Settings the runner, the sync and the planner write for their own use; the dashboard shows none of them. */
export const BOOKKEEPING_SETTINGS = [
  "runner_heartbeat", "schema_stamp", "schema_generation", "fts_built", "hashes_built", "text_refs_built", "diff_facts_built", "mentions_built", "item_stage_built", "tracking_started_at",
  "pipeline_planned_at", "pipeline_seqs_seen", "pipeline_wake_at", "pipeline_status", "pipeline_sync_seen", "pipeline_sync_at", "pipeline_review_cursor", "pipeline_verify_cursor",
  "full_sync_cursor", "org_high_water", "main_ci_polled_at", "releases_polled_at", "releases_offset", "search_catchup_at", "repos_refreshed_at", "sync_rate_remaining", "sync_rate_reset_at",
  "flow_summary_marks", "warm_gc_at", "warm_report", "liveness_at", "liveness_open", "classify_run", "worker_update_pending", "worker_update_failures",
];
const BOOKKEEPING_SETTING_LIKE = ["leader:%", "warm\\_bytes:%", "%\\_points\\_last\\_run", "pipeline\\_fp:%", "build\\_feature:%", "pr\\_builds\\_%"];

/** SQL condition on `key` that is true for the settings that matter to a page. */
function shownSettings(key: string): string {
  const names = BOOKKEEPING_SETTINGS.map((k) => `'${k}'`).join(", ");
  const likes = BOOKKEEPING_SETTING_LIKE.map((l) => ` AND ${key} NOT LIKE '${l}' ESCAPE '\\'`).join("");
  return `${key} NOT IN (${names})${likes}`;
}

/** topic -> the tables whose changes it reports. */
export const TOPIC_TABLES: Record<string, Source[]> = {
  repos: [{ table: "repos" }, { table: "tracked_repos" }],
  sync: [{ table: "sync_runs" }],
  items: [{ table: "items" }, { table: "comments" }, { table: "whitelist_overrides" }],
  ranks: [{ table: "item_rank" }, { table: "item_priority" }],
  stages: [{ table: "stages" }, { table: "item_stage" }],
  flow: [{ table: "flow_summary" }],
  checks: [{ table: "pr_checks" }, { table: "ci_run_approvals" }],
  mainci: [{ table: "main_ci" }, { table: "main_fixes" }],
  classify: [{ table: "classifications" }, { table: "item_areas" }, { table: "area_lists" }, { table: "area_proposals" }],
  dupes: [{ table: "duplicate_pairs" }, { table: "duplicate_scans" }],
  // A snooze or wake: the inbox changes, the pipeline's input does not (the `decisions` topic skips these columns).
  "decision-snooze": [{ table: "decisions", ops: ["UPDATE"], when: "old.snoozed_at IS NOT new.snoozed_at" }],
  decisions: [{ table: "decisions" }, { table: "decision_opinions" }, { table: "decision_comments" },
    { table: "dupe_comparisons" }, { table: "dupe_groups" }, { table: "dupe_group_items" }, { table: "dupe_group_posts" }, { table: "dupe_group_texts" }],
  // Who is looking at which question: presence only, so a claim refetches the lists that show it and nothing else.
  claims: [{ table: "decision_claims" }],
  // diff_facts: what the merge rule reads from a reviewed head's diff (sensitive content, size, extras pending).
  reviews: [{ table: "opus_reviews" }, { table: "review_posts" }, { table: "diff_facts" }],
  queue: [{ table: "merges" }, { table: "merge_batches" }, { table: "merge_batch_prs" }, { table: "merge_holds" }, { table: "premerge_reviews" }],
  fasttrack: [{ table: "fast_track" }],
  // Started items of the maintainer workflow: entry, approval, weight, plan, blocker, recommendation. Planner input.
  workflows: [{ table: "item_workflows" }],
  // What people said to items of the maintainer workflow: an unclear answer lives only here. Lists only; not planner input.
  "workflow-events": [{ table: "workflow_events" }],
  // An operator released an outside-author item from its hold: the planner plans for it at once.
  outside: [{ table: "outside_released" }, { table: "stage_trips", when: "new.stage = 'outside-surge'" }],
  // The planner's Plan cache; its own output, so the planner does not plan again for it.
  plans: [{ table: "item_plans" }, { table: "lane_next" }, { table: "liveness_items" }, { table: "outside_holds" }],
  jobs: [{ table: "jobs" }, { table: "stage_limits" }, { table: "stage_trips" }],
  // The breaker and limit rows alone, for pages that do not follow every job.
  limits: [{ table: "stage_limits" }, { table: "stage_trips" }],
  usage: [{ table: "token_usage" }, { table: "account_usage_samples" }],
  accounts: [{ table: "claude_accounts" }, { table: "claude_account_status" }, { table: "claude_account_tokens" }],
  agents: [{ table: "agent_runs" }, { table: "agent_run_items" }, { table: "agent_run_texts" }],
  // Every worker poll writes last_seen_at; only changes to what an environment is or reports matter.
  // The runner's caches report (settings row `warm_report`, src/build/caches.ts) is shown on the environments page.
  envs: [{ table: "settings", when: "new_key = 'warm_report'" }, { table: "build_envs", ops: ["INSERT", "DELETE"] }, { table: "build_envs", ops: ["UPDATE"], when: "old.label IS NOT new.label OR old.kind IS NOT new.kind OR old.enabled IS NOT new.enabled OR old.slots IS NOT new.slots OR old.key_hash IS NOT new.key_hash OR old.capabilities IS NOT new.capabilities OR old.reported_slots IS NOT new.reported_slots OR old.version IS NOT new.version OR old.paused_reason IS NOT new.paused_reason OR old.confidential IS NOT new.confidential OR old.settings IS NOT new.settings OR old.health IS NOT new.health" }],
  // The build feature switches (settings rows `build_feature:*`); not planner input.
  "build-features": [{ table: "settings", when: "new_key LIKE 'build\\_feature:%' ESCAPE '\\' OR new_key LIKE 'pr\\_builds\\_%' ESCAPE '\\'" }, { table: "screenshot_config" }],
  // Our workspace builds of PR heads (pr-builds feature); read by the item page and queue cards, not planner input.
  "pr-builds": [{ table: "pr_builds" }],
  // The nightly selection, runs, results and bench points; written by the nightly step's bookkeeping, not planner input.
  nightly: [{ table: "nightly_selection" }, { table: "nightly_runs" }, { table: "nightly_results" }, { table: "nightly_bench" }],
  // The workspace page: the pods, their sessions and every call; not planner input.
  workspaces: [{ table: "workspaces" }, { table: "workspace_sessions" }, { table: "workspace_calls" }],
  tasks: [{ table: "build_tasks" }, { table: "build_task_logs" }, { table: "build_artifacts" }],
  actions: [{ table: "actions" }],
  // Which maintainer posts an operator shared with Opus; not planner input.
  "conversation-includes": [{ table: "conversation_includes" }],
  // Decision answers' choices rows (bookkeeping, not planner input).
  "decision-choices": [{ table: "decision_choices" }],
  conversations: [{ table: "conversations" }, { table: "conversation_turns" }, { table: "conversation_cards" }],
  // Follow-up issues held until the merge; the Act lane reads the item, decision and pre-approval rows that move them, so not planner input.
  "held-followups": [{ table: "held_followups" }],
  // Implementations and the Implement switches are planner input: a queued issue's next step reads them.
  fixes: [{ table: "fix_attempts" }, { table: "patch_checks" }, { table: "dupe_carries" }, { table: "implementations" }, { table: "implementation_rounds" },
    { table: "settings", when: "new_key LIKE 'build\\_feature:implement%' ESCAPE '\\'" }],
  verify: [{ table: "verifications" }, { table: "fixups" }, { table: "ci_fixes" }],
  // Pre-approved merges and the operator fix-ups behind them: the planner works them, so the topic is planner input.
  preapprovals: [{ table: "preapprovals" }, { table: "operator_fixups" }],
  // Discord mention counts, the bot's channel list and its filing-only repos; not planner input.
  discord: [{ table: "discord_mentions" }, { table: "discord_channels" }, { table: "discord_categories" }, { table: "discord_status" }, { table: "discord_events" }, { table: "discord_filing_repos" }, { table: "discord_hidden_repos" }],
  "discord-links": [{ table: "discord_links" }],
  downloads: [{ table: "release_assets" }, { table: "release_apps" }, { table: "download_deltas" }, { table: "star_samples" }],
  // Operator and maintainer pages only; not planner input.
  security: [{ table: "security_scans" }, { table: "security_areas" }, { table: "security_findings" }, { table: "security_calls" }, { table: "security_fix_rounds" }, { table: "security_fix_log" }, { table: "security_scan_tests" }],
  postmerge: [{ table: "postmerge_reviews" }, { table: "postmerge_followups" }, { table: "premerge_reviews" }],
  // Sessions change on every request (last_seen); only sign-ins and revocations matter.
  access: [{ table: "access" }, { table: "sessions", ops: ["INSERT", "DELETE"] }, { table: "audit" }],
  settings: [{ table: "settings", when: `${shownSettings("new_key")}` }],
  // What decides an item's next pipeline step and its place in line (src/rank/position.ts). Narrower than the page topics:
  // no comment, claim or opinion writes, and only the item and decision columns that change a step.
  steps: [
    { table: "items", ops: ["INSERT", "DELETE"] },
    { table: "items", ops: ["UPDATE"], when: "old.state IS NOT new.state OR old.head_oid IS NOT new.head_oid OR old.kind IS NOT new.kind OR old.author IS NOT new.author" },
    { table: "decisions", ops: ["INSERT", "DELETE"] },
    { table: "decisions", ops: ["UPDATE"], when: "old.answer IS NOT new.answer OR old.kind IS NOT new.kind OR old.repo IS NOT new.repo OR old.number IS NOT new.number OR old.items IS NOT new.items" },
    { table: "dupe_group_items" }, { table: "item_rank" }, { table: "classifications", ops: ["INSERT", "DELETE"] },
    { table: "classifications", ops: ["UPDATE"], when: ["classifier", "run_id", "at", "type_label", "want", "reference", "flags", "dup_of", "reason", "probs", "input_hash"].map((c) => `old.${c} IS NOT new.${c}`).join(" OR ") },
    { table: "opus_reviews" }, { table: "verifications" },
    { table: "fix_attempts" }, { table: "implementations" }, { table: "postmerge_followups" }, { table: "premerge_reviews" }, { table: "pr_checks" }, { table: "push_outcomes" }, { table: "stage_trips" }, { table: "fast_track" }, { table: "merge_holds" }, { table: "merges" }, { table: "merge_batches" },
    { table: "merge_batch_prs" }, { table: "tracked_repos" }, { table: "item_workflows" },
    { table: "settings", when: "new_key IN ('pilot_items', 'classify_run', 'pipeline_login')" },
  ],
  // What runRank reads (src/rank/index.ts): the rank lane's work test. Only the columns and settings that move a score.
  "rank-inputs": [
    { table: "items", ops: ["INSERT", "DELETE"] },
    { table: "items", ops: ["UPDATE"], when: "old.state IS NOT new.state OR old.kind IS NOT new.kind OR old.additions IS NOT new.additions OR old.deletions IS NOT new.deletions" },
    { table: "item_priority", ops: ["INSERT", "DELETE"] },
    { table: "item_priority", ops: ["UPDATE"], when: "old.impact IS NOT new.impact OR old.score IS NOT new.score" },
    { table: "fix_attempts", ops: ["INSERT", "DELETE"] },
    { table: "fix_attempts", ops: ["UPDATE"], when: "old.size IS NOT new.size" },
    { table: "classifications" },
    { table: "tracked_repos" },
    { table: "settings", when: "new_key = 'classify_run'" },
  ],
  // What the item trace reads that no page topic watches. A model call's progress line is not a change here.
  trace: [
    { table: "model_checks" }, { table: "conflict_merges" }, { table: "job_items" }, { table: "opus_review_history" }, { table: "plan_history" }, { table: "patch_checks" },
    { table: "pr_files" }, { table: "pr_commits" }, { table: "screenshot_runs" }, { table: "item_activity" }, { table: "agent_run_items" }, { table: "agent_run_tools" },
    { table: "workflow_events" },
    { table: "agent_runs", ops: ["INSERT"] },
    // The item page's status bar follows a job starting, queuing and ending, not its progress lines.
    { table: "jobs", ops: ["INSERT"] },
    { table: "jobs", ops: ["UPDATE"], when: "old.state IS NOT new.state OR old.started_at IS NOT new.started_at OR old.ended_at IS NOT new.ended_at" },
    { table: "agent_runs", ops: ["UPDATE"], when: "old.state IS NOT new.state OR old.ended_at IS NOT new.ended_at OR old.cost_usd IS NOT new.cost_usd OR old.summary IS NOT new.summary" },
  ],
  // The user-local helpers' readiness and their leases starting and ending, for the Connect page; not planner input.
  "remote-helpers": [{ table: "remote_helpers" }, { table: "remote_calls", ops: ["UPDATE"], when: "old.state IS NOT new.state AND (new.state = 'leased' OR old.state = 'leased')" }],
  // Model calls entering or leaving the queue, picks changing and Task Runners becoming ready or not: held claims and the
  // queue view; not planner input. A runner's status report rewrites reported_at, which is not a change here.
  "remote-queue": [
    { table: "remote_helpers", ops: ["INSERT", "DELETE"] },
    { table: "remote_helpers", ops: ["UPDATE"], when: "old.readiness IS NOT new.readiness OR old.models IS NOT new.models OR old.slots IS NOT new.slots" },
    { table: "remote_calls", ops: ["INSERT"] },
    { table: "remote_calls", ops: ["UPDATE"], when: "(old.state IS NOT new.state AND (new.state = 'queued' OR old.state = 'queued')) OR old.picked_by IS NOT new.picked_by OR old.pick_until IS NOT new.pick_until" },
  ],
  // Rows of the audit table that record a write on GitHub.
  github: [{ table: "audit", ops: ["INSERT", "UPDATE"], when: `new.action IN (${Object.keys(GITHUB_ACTIONS).map((a) => `'${a}'`).join(", ")})` }],
};

export const TOPICS = Object.keys(TOPIC_TABLES);

const ALL_OPS = ["INSERT", "UPDATE", "DELETE"] as const;

/** The columns an UPDATE of `table` must change to count: all of them but the bookkeeping ones. */
export function watchedColumns(table: string, columns: Map<string, string[]> | undefined): string[] | null {
  const all = columns?.get(table);
  if (!all) return null;
  const skip = new Set(BOOKKEEPING_COLUMNS[table] ?? []);
  return all.filter((c) => !skip.has(c));
}

/** Column names of every table, for the UPDATE conditions. */
export function columnsOf(db: DatabaseSync): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const { name } of db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'").all() as { name: string }[]) {
    out.set(name, (db.prepare(`PRAGMA main.table_info('${name}')`).all() as { name: string }[]).map((c) => c.name));
  }
  return out;
}

/** One live trigger: an AFTER `op` on `table` that bumps `topic` when `cond` (SQLite syntax, `new`/`old` rows) holds. */
export type LiveTrigger = { name: string; topic: string; table: string; op: "INSERT" | "UPDATE" | "DELETE"; cond: string };

/**
 * The topics' triggers. With `columns`, an UPDATE trigger fires only when a watched column changed. Two sources that make the
 * same name are one trigger, the later one, as SQLite keeps it (DROP and CREATE again): `access` and `github` both name
 * live_audit_i and live_audit_u, `outside` and `jobs` live_stage_trips_*.
 */
export function liveTriggers(columns?: Map<string, string[]>): LiveTrigger[] {
  const out = new Map<string, LiveTrigger>();
  for (const [topic, sources] of Object.entries(TOPIC_TABLES)) {
    for (const { table, ops = ALL_OPS, when } of sources) {
      for (const op of ops) {
        // `steps`, `trace`, `limits`, `decision-snooze`, `build-features` and `remote-queue` read tables other topics already watch, and a
        // settings source outside the `settings` topic reads that topic's table; their triggers need names of their own.
        const own = topic === "steps" || topic === "trace" || topic === "limits" || topic === "decision-snooze" || topic === "build-features" || topic === "remote-queue" || topic === "rank-inputs"
          || (table === "settings" && topic !== "settings");
        const name = `live_${own ? `${topic.replace(/\W/g, "_")}_` : ""}${table}_${op[0]!.toLowerCase()}`;
        const key = op === "DELETE" ? "old.key" : "new.key";
        let cond = when ? when.replaceAll("new_key", key) : "";
        if (op === "UPDATE" && !when) {
          const watched = watchedColumns(table, columns);
          if (watched?.length) cond = watched.map((c) => `old."${c}" IS NOT new."${c}"`).join(" OR ");
        }
        out.delete(name);
        out.set(name, { name, topic, table, op, cond });
      }
    }
  }
  return [...out.values()];
}

/** The marker table's DDL (SQLite; src/db/pg-triggers.ts translates it). */
export const CHANGE_SEQ_TABLE = "CREATE TABLE IF NOT EXISTS main.change_seq (topic TEXT PRIMARY KEY, seq INTEGER NOT NULL, at TEXT) WITHOUT ROWID;";

/**
 * DDL for the marker table, its rows and the triggers. Idempotent: triggers are rebuilt. With `db`, an
 * UPDATE trigger fires only when a watched column changed, so a rewrite of identical values bumps nothing.
 * Postgres gets the same topics from src/db/pg-triggers.ts.
 */
export function liveSql(db?: DatabaseSync): string {
  const out = [CHANGE_SEQ_TABLE, ...TOPICS.map((t) => `INSERT OR IGNORE INTO main.change_seq (topic, seq, at) VALUES ('${t}', 0, NULL);`)];
  for (const { name, topic, table, op, cond } of liveTriggers(db ? columnsOf(db) : undefined)) {
    // Unqualified change_seq: a trigger body may not name a schema.
    out.push(`DROP TRIGGER IF EXISTS main.${name};`);
    out.push(`CREATE TRIGGER main.${name} AFTER ${op} ON ${table} ${cond ? `WHEN ${cond}` : ""} BEGIN
          UPDATE change_seq SET seq = seq + 1 WHERE topic = '${topic}';
        END;`);
  }
  return out.join("\n");
}

/** The current counter of every topic. */
export async function readSeqs(db: Db): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const r of await db.all(db.k.selectFrom("change_seq").select(["topic", "seq"]))) out[r.topic] = r.seq;
  return out;
}
