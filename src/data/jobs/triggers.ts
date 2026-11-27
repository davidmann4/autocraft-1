// The live topics this module's tables feed (src/db/live.ts).
import { registerTriggerSource } from "../../db/live.ts";

// The planner's Plan cache; its own output, so the planner does not plan again for it.
registerTriggerSource("plans",
  { table: "lane_next" },
);

registerTriggerSource("jobs",
  { table: "jobs" },
);

// Jobs that ended, whoever asked for them and whenever their end is dated, and leases given back: what they kept others from can start.
registerTriggerSource("job-ends",
  { table: "jobs", ops: ["INSERT"], when: "new.ended_at IS NOT NULL" },
  { table: "jobs", ops: ["UPDATE"], when: "new.ended_at IS NOT NULL AND old.ended_at IS NOT new.ended_at" },
  { table: "work_leases", ops: ["DELETE"] },
);
