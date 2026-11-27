// The live topics this module's tables feed (src/db/live.ts).
import { registerTriggerSource } from "../../db/live.ts";

registerTriggerSource("repos",
  { table: "repos" },
);

registerTriggerSource("sync",
  { table: "sync_runs" },
);

registerTriggerSource("items",
  { table: "items" },
  { table: "comments" },
);

// An operator's comment may become an owner statement (src/data/conversations/statements.ts).
registerTriggerSource("statement-sources",
  { table: "comments", ops: ["INSERT", "UPDATE"], when: "EXISTS (SELECT 1 FROM access sa WHERE sa.login = new.author AND sa.role = 'operator')",
    pg: "EXISTS (SELECT 1 FROM access sa WHERE sa.login = new.author::citext AND sa.role = 'operator')" },
);

registerTriggerSource("checks",
  { table: "pr_checks" },
);

registerTriggerSource("mainci",
  { table: "main_ci" },
);

// diff_facts: what the merge rule reads from a reviewed head's diff (sensitive content, size, extras pending).
registerTriggerSource("reviews",
  { table: "diff_facts" },
);

registerTriggerSource("downloads",
  { table: "release_assets" },
  { table: "release_apps" },
  { table: "download_deltas" },
  { table: "star_samples" },
);

// Planner input no other input topic reports (src/db/plan-inputs.ts). 
// A live review read moves the facts when its answer changes or when it replaces a read the PR has changed since: the merge and CI fix
// jobs read it again on every run, so a repeat of a current read must not count. Failed reads of an author's permission only hold back.
registerTriggerSource("plan-inputs",
  { table: "review_gates", ops: ["INSERT"], when: "new.read_at IS NOT NULL" },
  { table: "review_gates", ops: ["UPDATE"], when: `old.blocked IS NOT new.blocked OR old.by_login IS NOT new.by_login
    OR (old.read_at IS NOT new.read_at AND EXISTS (SELECT 1 FROM items gi WHERE gi.repo = new.repo AND gi.number = new.number AND COALESCE(gi.updated_at, '') >= COALESCE(old.read_at, '')))` },
  { table: "author_permissions", ops: ["INSERT"], when: "new.permission IS NOT NULL" },
  { table: "author_permissions", ops: ["UPDATE"], when: "old.permission IS NOT new.permission OR old.author_id IS NOT new.author_id OR (old.failures > 0 AND new.failures = 0)" },
  { table: "author_ids" },
);
