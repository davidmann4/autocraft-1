// The live topics this module's tables feed (src/db/live.ts).
import { registerTriggerSource } from "../../db/live.ts";

// Implementations and the Implement switches are planner input: a queued issue's next step reads them.
registerTriggerSource("fixes",
  { table: "implementations" },
  { table: "implementation_rounds" },
  { table: "settings", when: "new_key LIKE 'build\\_feature:implement%' ESCAPE '\\'" },
);
