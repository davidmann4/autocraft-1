// The live topics this module's tables feed (src/db/live.ts).
import { registerTriggerSource } from "../../db/live.ts";

// Started items of the maintainer workflow: entry, approval, weight, plan, blocker, recommendation. Planner input.
registerTriggerSource("workflows",
  { table: "item_workflows" },
);

// What people said to items of the maintainer workflow: an unclear answer lives only here. Lists only; not planner input.
// The archive of the decision system (src/db/switch-over.ts) is history: it moves no topic.
registerTriggerSource("workflow-events",
  { table: "workflow_events", ops: ["INSERT", "UPDATE"], when: "new.kind <> 'archived'" },
  { table: "workflow_events", ops: ["DELETE"], when: "old.kind <> 'archived'" },
);

// Pre-approved merges and the operator fix-ups behind them: the planner works them, so the topic is planner input.
registerTriggerSource("preapprovals",
  { table: "preapprovals" },
  { table: "operator_fixups" },
);

registerTriggerSource("actions",
  { table: "workflow_actions" },
);

// A Task Runner taken onto an item's work changes which runners may claim its queued calls: what a held claim reacts to. Not planner input.
registerTriggerSource("remote-queue",
  { table: "item_runners" },
);
