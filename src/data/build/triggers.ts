// The live topics this module's tables feed (src/db/live.ts).
import { registerTriggerSource } from "../../db/live.ts";
import { TERMINAL } from "./types.ts";

// Every worker poll writes last_seen_at; only changes to what an environment is or reports matter.
// The runner's caches report (build_state row `warm_report`) is shown on the environments page.
registerTriggerSource("envs",
  { table: "build_state", when: "new_key = 'warm_report'" },
  { table: "build_envs", ops: ["INSERT","DELETE"] },
  { table: "build_envs", ops: ["UPDATE"], when: "old.label IS NOT new.label OR old.kind IS NOT new.kind OR old.enabled IS NOT new.enabled OR old.slots IS NOT new.slots OR old.key_hash IS NOT new.key_hash OR old.capabilities IS NOT new.capabilities OR old.reported_slots IS NOT new.reported_slots OR old.version IS NOT new.version OR old.paused_reason IS NOT new.paused_reason OR old.confidential IS NOT new.confidential OR old.settings IS NOT new.settings OR old.health IS NOT new.health" },
);

// The build feature switches (settings rows `build_feature:*`); not planner input.
registerTriggerSource("build-features",
  { table: "settings", when: "new_key LIKE 'build\\_feature:%' ESCAPE '\\' OR new_key LIKE 'pr\\_builds\\_%' ESCAPE '\\'" },
);

// The workspace page: the pods, their sessions and every call; not planner input.
registerTriggerSource("workspaces",
  { table: "workspaces" },
  { table: "workspace_sessions" },
  { table: "workspace_calls" },
);

registerTriggerSource("tasks",
  { table: "build_tasks" },
  { table: "build_task_logs" },
  { table: "build_artifacts" },
);

// Sandbox tasks that ended: the lanes that read their results.
const ENDED = `new.state IN (${TERMINAL.map((s) => `'${s}'`).join(", ")})`;
registerTriggerSource("task-ends",
  { table: "build_tasks", ops: ["INSERT"], when: ENDED },
  { table: "build_tasks", ops: ["UPDATE"], when: `${ENDED} AND (old.state IS NOT new.state OR old.ended_at IS NOT new.ended_at)` },
);
