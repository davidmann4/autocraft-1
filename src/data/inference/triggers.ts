// The live topics this module's tables feed (src/db/live.ts).
import { registerTriggerSource } from "../../db/live.ts";

registerTriggerSource("usage",
  { table: "token_usage" },
);

registerTriggerSource("agents",
  { table: "agent_runs" },
  { table: "agent_run_items" },
  { table: "agent_run_texts" },
);

// The nightly selection, runs, results and bench points; written by the nightly step's bookkeeping, not planner input.
registerTriggerSource("nightly",
  { table: "nightly_selection" },
  { table: "nightly_runs" },
  { table: "nightly_results" },
  { table: "nightly_bench" },
);
