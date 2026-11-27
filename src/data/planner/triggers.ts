// The live topics this module's tables feed (src/db/live.ts).
import { registerTriggerSource } from "../../db/live.ts";

/** The candidate states of src/workflow/auto-stop.ts, on a plan of a PR the automatic merge rule takes up by itself (PlanView.auto). */
const AUTO = `LIKE '%"auto":true%'`;
const AUTO_STOP = `new.kind = 'pr' AND new.state IN ('needs-decision', 'opus-hold', 'opus-close', 'verify-failed', 'verify-error') AND new.view ${AUTO}`;

registerTriggerSource("stages",
  { table: "stages" },
  { table: "item_stage" },
);

// The planner's Plan cache; its own output, so the planner does not plan again for it.
registerTriggerSource("plans",
  { table: "item_plans" },
  { table: "liveness_items" },
);

// A stored plan of a PR on the automatic merge rule that enters a state the rule stops in for a person, changes its reasons there, or
// comes back to the rule there: the workflow pass starts its question at once (src/workflow/auto-stop.ts). Not a planner input.
registerTriggerSource("auto-stops",
  { table: "item_plans", ops: ["INSERT"], when: `${AUTO_STOP}` },
  { table: "item_plans", ops: ["UPDATE"], when: `${AUTO_STOP} AND (old.state IS NOT new.state OR old.reasons IS NOT new.reasons OR old.view NOT ${AUTO})` },
);

// What decides an item's next pipeline step and its place in line (src/rank/position.ts). Narrower than the page topics:
// no comment writes, and only the item columns that change a step.
registerTriggerSource("steps",
  { table: "items", ops: ["INSERT","DELETE"] },
  { table: "items", ops: ["UPDATE"], when: "old.state IS NOT new.state OR old.head_oid IS NOT new.head_oid OR old.kind IS NOT new.kind OR old.author IS NOT new.author" },
  { table: "dupe_group_items" },
  { table: "item_rank" },
  { table: "classifications", ops: ["INSERT","DELETE"] },
  { table: "classifications", ops: ["UPDATE"], when: "old.classifier IS NOT new.classifier OR old.run_id IS NOT new.run_id OR old.at IS NOT new.at OR old.type_label IS NOT new.type_label OR old.want IS NOT new.want OR old.reference IS NOT new.reference OR old.flags IS NOT new.flags OR old.dup_of IS NOT new.dup_of OR old.reason IS NOT new.reason OR old.probs IS NOT new.probs OR old.input_hash IS NOT new.input_hash" },
  { table: "opus_reviews" },
  { table: "verifications" },
  { table: "implementations" },
  { table: "postmerge_followups" },
  { table: "premerge_reviews" },
  { table: "premerge_followups" },
  { table: "review_followups" },
  { table: "pr_checks" },
  { table: "push_outcomes" },
  { table: "stage_trips" },
  { table: "merges" },
  { table: "merge_batches" },
  { table: "merge_batch_prs" },
  { table: "tracked_repos" },
  { table: "item_workflows" },
  { table: "settings", when: "new_key = 'pipeline_login'" },
  { table: "classify_state", ops: ["INSERT","UPDATE"], when: "new.kind = 'current_run'" },
  { table: "classify_state", ops: ["DELETE"], when: "old.kind = 'current_run'" },
);

// What runRank reads (src/rank/index.ts): the rank lane's work test. Only the columns and settings that move a score.
registerTriggerSource("rank-inputs",
  { table: "items", ops: ["INSERT","DELETE"] },
  { table: "items", ops: ["UPDATE"], when: "old.state IS NOT new.state OR old.kind IS NOT new.kind OR old.additions IS NOT new.additions OR old.deletions IS NOT new.deletions" },
  { table: "item_priority", ops: ["INSERT","DELETE"] },
  { table: "item_priority", ops: ["UPDATE"], when: "old.impact IS NOT new.impact OR old.score IS NOT new.score" },
  { table: "classifications" },
  { table: "tracked_repos" },
  { table: "classify_state", ops: ["INSERT","UPDATE"], when: "new.kind = 'current_run'" },
  { table: "classify_state", ops: ["DELETE"], when: "old.kind = 'current_run'" },
);

// What the item trace reads that no page topic watches. A model call's progress line is not a change here.
registerTriggerSource("trace",
  { table: "model_checks" },
  { table: "conflict_merges" },
  { table: "job_items" },
  { table: "opus_review_history" },
  { table: "plan_history" },
  { table: "patch_checks" },
  { table: "pr_files" },
  { table: "pr_commits" },
  { table: "screenshot_runs" },
  { table: "item_activity" },
  { table: "agent_run_items" },
  { table: "agent_run_tools" },
  { table: "workflow_events", ops: ["INSERT", "UPDATE"], when: "new.kind <> 'archived'" },
  { table: "workflow_events", ops: ["DELETE"], when: "old.kind <> 'archived'" },
  { table: "agent_runs", ops: ["INSERT"] },
  { table: "jobs", ops: ["INSERT"] },
  { table: "jobs", ops: ["UPDATE"], when: "old.state IS NOT new.state OR old.started_at IS NOT new.started_at OR old.ended_at IS NOT new.ended_at" },
  { table: "agent_runs", ops: ["UPDATE"], when: "old.state IS NOT new.state OR old.ended_at IS NOT new.ended_at OR old.cost_usd IS NOT new.cost_usd OR old.summary IS NOT new.summary" },
);
