// The tables and columns the maintainer workflow retired, and whether this release removes them (src/db/retired.ts).

/** Turns the removal on. One release after the switch to the maintainer workflow; a rollback past it needs a restore. */
export const DROP_RETIRED: boolean = false;

/** `decisions` last: the rows of `actions` and the others are explained by it. */
export const RETIRED_TABLES: readonly string[] = [
  "actions", "decision_choices", "decision_claims", "decision_comments", "decision_items", "decision_opinions", "decision_prepares",
  "dupe_group_texts", "dupe_group_posts", "dupe_group_fails", "dupe_carries", "fast_track", "fix_attempts",
  "claude_account_status", "claude_account_tokens", "account_usage_samples", "claude_accounts",
  "flow_summary", "opus_carried_fixes", "model_waits", "conversation_includes", "merge_holds", "decisions",
];

export const RETIRED_COLUMNS: readonly (readonly [table: string, column: string])[] = [
  ["tracked_repos", "workflow"],
  ["implementations", "decision_id"],
  ["held_followups", "decision_id"], ["held_followups", "choice_id"], ["held_followups", "answer_seq"],
  ["main_fixes", "decision_id"],
  ["nightly_results", "decision_id"],
  ["discord_alert_msgs", "decision_id"], ["discord_alert_msgs", "choices_id"],
  ["dupe_groups", "decision_id"], ["dupe_groups", "applied_answer"],
  ["dupe_group_items", "decision_id"], ["dupe_group_items", "head"],
  ["items", "jev_failed_hash"],
  ["mcp_tokens", "idle_claim_at"], ["mcp_tokens", "idle_tiers"], ["mcp_tokens", "idle_repos"], ["mcp_tokens", "machine"],
  ["agent_runs", "account_id"],
];

/** Values of retired columns a row still needs while the columns exist (a key, a NOT NULL column): nothing once they are dropped. */
export const retiredColumns = <T extends object>(values: T): T => (DROP_RETIRED ? {} as T : values);
