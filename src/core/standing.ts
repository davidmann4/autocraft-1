// Whom started work acts for, and whether they still count on the repo. One rule for the planner's facts, the merge legs and the workflow
// pass; the answer on one person is data/access `standing`. Pure.
import type { Standing } from "../data/access/types.ts";
import type { Entry } from "../workflow/types.ts";
import { settlerOf } from "../workflow/work.ts";
import type { StandingFact } from "./plan.ts";

/** What a started item does as a person: the merge, or the other writes and the work behind them. */
export type Act = "merge" | "work";

/** `actors`: who the workflow acts for, newest first (data/workflow workflowActors). */
export type Acting = { entry: Entry; startedBy: string; approvedBy: string | null; actors: readonly string[] };

/**
 * The people the act may run for, the one who counts first when more than one does. The merge runs for the person who approved it (a merge
 * entry nobody approved since: who started it); other work for whoever last answered, approved or started the item.
 */
function actorsFor(w: Acting, act: Act): string[] {
  if (act === "work") return [...w.actors];
  const by = w.approvedBy ?? (w.entry === "merge" ? w.startedBy : null);
  return by === null ? [] : [by];
}

/** Who the act runs for and whether they count (`of`); null without a live workflow, and for a merge nobody approved. `boxIdentity`: GitHub writes go out as the box account. */
export function standingFor(w: Acting | null, act: Act, of: (login: string) => Standing, o: { boxIdentity?: boolean } = {}): StandingFact | null {
  const s = w && settlerOf(actorsFor(w, act), of);
  return s ? { login: s.by, standing: s.standing, ...(o.boxIdentity ? { boxIdentity: true } : {}) } : null;
}
