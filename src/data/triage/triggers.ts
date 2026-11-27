// The live topics this module's tables feed (src/db/live.ts).
import { registerTriggerSource } from "../../db/live.ts";

registerTriggerSource("ranks",
  { table: "item_rank" },
  { table: "item_priority" },
);

registerTriggerSource("classify",
  { table: "classifications" },
  { table: "item_areas" },
  { table: "area_lists" },
  { table: "area_proposals" },
);

registerTriggerSource("dupes",
  { table: "duplicate_pairs" },
  { table: "duplicate_scans" },
  { table: "dupe_comparisons" },
  { table: "dupe_groups" },
  { table: "dupe_group_items" },
);

// Planner input no other input topic reports (src/db/plan-inputs.ts). A rewritten vector is a new row.
registerTriggerSource("plan-inputs",
  { table: "item_embeddings", ops: ["INSERT"] },
  { table: "item_embeddings", ops: ["UPDATE"], when: "old.model IS NOT new.model OR old.hash IS NOT new.hash" },
  { table: "classify_state", ops: ["INSERT"], when: "new.kind = 'jev_failed'" },
  { table: "classify_state", ops: ["UPDATE"], when: "new.kind = 'jev_failed' AND old.value IS NOT new.value" },
);
