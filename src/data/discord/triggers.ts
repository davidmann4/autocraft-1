// The live topics this module's tables feed (src/db/live.ts).
import { registerTriggerSource } from "../../db/live.ts";

// Discord mention counts, the bot's channel list and its filing-only repos; not planner input.
registerTriggerSource("discord",
  { table: "discord_mentions" },
  { table: "discord_channels" },
  { table: "discord_categories" },
  { table: "discord_status" },
  { table: "discord_events" },
  { table: "discord_filing_repos" },
  { table: "discord_hidden_repos" },
);
// A contributor role request from the /verify pages wakes the runner, which gives the role; not planner input.
registerTriggerSource("discord-verify",
  { table: "discord_role_grants", ops: ["INSERT"] },
);
