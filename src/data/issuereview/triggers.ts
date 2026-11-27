// The live topics this module's tables feed (src/db/live.ts).
import { registerTriggerSource } from "../../db/live.ts";

// A queued review or a question for the reporter is planner input, and a stored review moves the issue's workflow on.
registerTriggerSource("fixes", { table: "issue_reviews" });
