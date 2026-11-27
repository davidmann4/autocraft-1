// The live topics this module's tables feed (src/db/live.ts).
import { registerTriggerSource } from "../../db/live.ts";

// The chat of an item: what people wrote and AutoCraft's recommendations and end lines. Read by the item page; not planner input
// (src/runner/autopilot.ts INPUT_TOPICS): a message that matters to the pipeline comes with the workflow or turn row it produced.
registerTriggerSource("chat",
  { table: "chat_conversations" },
  { table: "chat_messages" },
);
