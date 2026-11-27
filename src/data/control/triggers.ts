// The live topics this module's tables feed (src/db/live.ts).
import { registerTriggerSource, shownSettings } from "../../db/live.ts";
import { GITHUB_ACTIONS } from "../../github/actions.ts";

registerTriggerSource("repos",
  { table: "tracked_repos" },
);

registerTriggerSource("jobs",
  { table: "stage_limits" },
  { table: "stage_trips" },
);

// The breaker and limit rows alone, for pages that do not follow every job.
registerTriggerSource("limits",
  { table: "stage_limits" },
  { table: "stage_trips" },
);

// Settings a page shows, and the per-repo step approvals (a table of their own).
registerTriggerSource("settings",
  { table: "settings", when: shownSettings("new_key") },
  { table: "repo_step_approvals" },
);

// Rows of the audit table that record a write on GitHub.
registerTriggerSource("github",
  { table: "audit", ops: ["INSERT", "UPDATE"], when: `new.action IN (${Object.keys(GITHUB_ACTIONS).map((a) => `'${a}'`).join(", ")})` },
);

// A purge of old audit rows. Their inserts and updates are the `github` topic's; the access topic follows the same table's deletes only.
registerTriggerSource("access",
  { table: "audit", ops: ["DELETE"] },
);
