// reads: (none; composes loaders)
// What the pipeline stopped: tripped breakers, steps whose daily limit is 0 and authors held at their limit.
import type { Db } from "../../db/index.ts";
import * as control from "../control/index.ts";
import * as intake from "../intake/index.ts";
import type { StageDefaults } from "../control/types.ts";
import type { Scope, StoppedFacts } from "./types.ts";

/** `limits`: the steps that have a daily limit and their defaults (feature constants); a step at 0 is stopped. */
export async function loadStopped(db: Db, scope: Pick<Scope, "hidden">, limits: { steps: readonly string[]; defaults: StageDefaults }): Promise<StoppedFacts> {
  const [trips, stageLimits, heldAuthors] = await db.together(() => Promise.all([
    control.loadTrips(db, { active: true }),
    control.loadStageLimits(db, limits.defaults),
    intake.listHeldAuthors(db, { hidden: scope.hidden }),
  ]));
  const zeroLimits = limits.steps.flatMap((step) => {
    const l = stageLimits.get(step);
    return l && l.perDay === 0 ? [{ step, updatedAt: l.updatedAt ?? "" }] : [];
  });
  return { trips: [...trips.values()].sort((a, b) => a.trippedAt.localeCompare(b.trippedAt) || a.stage.localeCompare(b.stage)), zeroLimits, heldAuthors };
}
