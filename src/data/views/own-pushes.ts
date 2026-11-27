// reads: changes.fixups, changes.ci_fixes, changes.conflict_merges, control.own_pushes, control.push_outcomes, workflow.autorepins
import { ownPushes, type RecordedPush } from "../../core/evidence.ts";
import type { Db } from "../../db/index.ts";
import { loadPushEdges, type PatchFacts, type PushEdge } from "../changes/index.ts";
import { loadMadePushes, loadPushOutcomeEdges } from "../control/index.ts";
import type { KeySource } from "../keys.ts";
import { loadRepinPushes } from "../workflow/index.ts";
import type { RefKey } from "../mirror/types.ts";

/** Every push AutoCraft made to each PR (core/evidence.ts): one wave. A PR without one has no entry. `patches`: the PRs' patch facts, when the caller loads them. */
export async function loadOwnPushes(db: Db, keys: KeySource, patches?: Promise<Map<RefKey, PatchFacts>>): Promise<Map<RefKey, RecordedPush[]>> {
  const edgesOf = async (): Promise<Map<RefKey, readonly PushEdge[]>> => (patches ? new Map([...await patches].map(([k, f]) => [k, f.pushes])) : await loadPushEdges(db, keys));
  const [made, edges, outcomes, repins] = await db.together(() => Promise.all([loadMadePushes(db, keys), edgesOf(), loadPushOutcomeEdges(db, keys), loadRepinPushes(db, keys)]));
  return new Map([...new Set([...made.keys(), ...edges.keys(), ...outcomes.keys(), ...repins.keys()])].map((k) => [k, ownPushes(made.get(k) ?? [], edges.get(k) ?? [], outcomes.get(k) ?? [], repins.get(k) ?? [])]));
}
