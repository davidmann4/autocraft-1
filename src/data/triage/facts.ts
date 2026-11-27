// The planner's triage facts (M08 triage-a).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import { loadVerdicts } from "./classify.ts";
import { loadItemFactRows } from "./cross.ts";
import { compareOf, dueSets } from "./dupe-sets.ts";
import { loadDupeState, loadUncheckedPairCounts } from "./dupes.ts";
import type { Level, RefKey, TriageFacts, TriageFactsCtx, TriageFactsResult } from "./types.ts";

const asText = (h: string | null, text: string | null): string | null => (h === "" ? text : h);

/**
 * One wave of 7 statements, independent of item and repo count: the per-item row, slim verdicts, unchecked pair counts and the
 * duplicate state. `compare` is how the item's due comparison set is settled; `compareDueAt` holds, for every member of a
 * duplicate set (keyed or not), when its set's answer next changes with the clock alone.
 */
export async function loadTriageFacts(db: Db, keys: KeySource, ctx: TriageFactsCtx): Promise<TriageFactsResult> {
  const facts = new Map<RefKey, TriageFacts>();
  if (Array.isArray(keys) && keys.length === 0) return { facts, compareDueAt: new Map() };
  const [rows, verdicts, pairs, dupes] = await db.together(() => Promise.all([
    loadItemFactRows(db, keys, ctx.model),
    loadVerdicts(db, keys, ctx.run, { slim: true }),
    loadUncheckedPairCounts(db, keys),
    ctx.dupes?.() ?? loadDupeState(db),
  ]));
  const due = dueSets(dupes, ctx.nowMs);
  const compare = compareOf(due.sets);
  for (const r of rows) {
    const ref = `${r.repo}#${r.number}`;
    facts.set(ref, {
      score: r.score,
      priority: r.impact === null ? null : { impact: r.impact as Level, hash: asText(r.pr_hash, r.embed_hash) },
      embeddedHash: asText(r.e_hash, r.embed_hash), scannedHash: asText(r.scan_hash, r.embed_hash), jevFailedHash: r.jev_failed,
      verdicts: verdicts.get(ref) ?? [], pairsToCheck: pairs.get(ref) ?? 0, compare: compare.get(ref) ?? null,
    });
  }
  return { facts, compareDueAt: due.dueAt };
}
