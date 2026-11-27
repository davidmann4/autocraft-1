// The live topics this module's tables feed (src/db/live.ts).
import { registerTriggerSource } from "../../db/live.ts";

registerTriggerSource("conversations",
  { table: "conversations" },
  { table: "conversation_turns" },
  { table: "conversation_cards" },
);

// What makes a source an owner-statement candidate (statements.ts): an operator's turn, or a statement removed. statementsDue
// (src/memory/statements.ts) collects only when this moved. Operators' comments and roles are registered by the mirror and access modules.
registerTriggerSource("statement-sources",
  { table: "conversation_turns", ops: ["INSERT", "UPDATE"], when: "new.kind = 'operator'" },
  { table: "owner_statements", ops: ["DELETE"] },
);
