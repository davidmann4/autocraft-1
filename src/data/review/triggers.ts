// The live topics this module's tables feed (src/db/live.ts).
import { registerTriggerSource } from "../../db/live.ts";

// diff_facts: what the merge rule reads from a reviewed head's diff (sensitive content, size, extras pending).
registerTriggerSource("reviews",
  { table: "opus_reviews" },
  { table: "review_posts" },
);

registerTriggerSource("postmerge",
  { table: "postmerge_reviews" },
  { table: "postmerge_followups" },
  { table: "premerge_reviews" },
  { table: "premerge_followups" },
  { table: "review_followups" },
);

// Planner input no other input topic reports (src/db/plan-inputs.ts). 
// A failed review's count and the day's rerun count only hold reviews back, and their jobs end.
registerTriggerSource("plan-inputs",
  { table: "review_state", ops: ["INSERT"], when: "new.stale_at IS NOT NULL" },
  { table: "review_state", ops: ["UPDATE"], when: "old.stale_at IS NOT new.stale_at" },
);
