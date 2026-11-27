// The live topics this module's tables feed (src/db/live.ts).
import { registerTriggerSource } from "../../db/live.ts";
import { permissionMoved } from "../../db/plan-inputs.ts";
import { PERM_READ_TTL } from "./permissions.ts";

registerTriggerSource("items",
  { table: "whitelist_overrides" },
);

registerTriggerSource("discord-links",
  { table: "discord_links" },
);

// Sessions change on every request (last_seen); only sign-ins and revocations matter.
registerTriggerSource("access",
  { table: "access" },
  { table: "sessions", ops: ["INSERT","DELETE"] },
);

// Who is an operator decides whose words become owner statements (src/data/conversations/statements.ts).
registerTriggerSource("statement-sources",
  { table: "access", ops: ["INSERT", "DELETE"] },
  { table: "access", ops: ["UPDATE"], when: "old.login IS NOT new.login OR old.role IS NOT new.role" },
);

// Planner input no other input topic reports (src/db/plan-inputs.ts). A permission's refresh while it is fresh, the app's keys and sessions are not.
const permission = permissionMoved(PERM_READ_TTL);
registerTriggerSource("plan-inputs",
  { table: "access", ops: ["INSERT", "DELETE"] },
  { table: "access", ops: ["UPDATE"], when: "old.login IS NOT new.login OR old.role IS NOT new.role OR old.github_id IS NOT new.github_id" },
  { table: "repo_permissions", ops: ["INSERT", "DELETE"] },
  { table: "repo_permissions", ops: ["UPDATE"], when: permission.sqlite, pg: permission.pg },
  { table: "github_app", ops: ["INSERT", "DELETE"] },
  { table: "github_app", ops: ["UPDATE"], when: "old.slug IS NOT new.slug" },
);

// Runner credentials, roles and cached write permissions as the model queue's room reads them (src/data/runners/runner-snapshot.ts):
// a credential's use (last_used_at) and a permission's refresh while it is fresh are not changes here.
registerTriggerSource("remote-room",
  { table: "mcp_tokens", ops: ["INSERT", "DELETE"] },
  { table: "mcp_tokens", ops: ["UPDATE"], when: "old.login IS NOT new.login OR old.kind IS NOT new.kind OR old.expires_at IS NOT new.expires_at" },
  { table: "access", ops: ["INSERT", "DELETE"] },
  { table: "access", ops: ["UPDATE"], when: "old.login IS NOT new.login OR old.role IS NOT new.role" },
  { table: "repo_permissions", ops: ["INSERT", "DELETE"] },
  { table: "repo_permissions", ops: ["UPDATE"], when: permission.sqlite, pg: permission.pg },
);
