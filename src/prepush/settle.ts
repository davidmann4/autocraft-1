import { loadPushingRows, settlePushingRows, type PushingSettle } from "../data/changes/index.ts";
import { loadMadePushes } from "../data/control/index.ts";
import { loadHeldLeaseKeys } from "../data/jobs/index.ts";
import type { Db } from "../db/index.ts";

/** The lease a job holds while it works on a pull request. */
export const prLease = (repo: string, number: number): string => `pr:${repo}#${number}`;

const short = (oid: string): string => oid.slice(0, 7);

/**
 * Fix-ups and CI fixes a stopped job left `pushing`, settled from heads just read from GitHub (a read, not the mirror): pushed when the
 * head, a push recorded as done or a later push of ours on top shows the commit. One that did not land is pushed again from its stored
 * patch, or made anew when it has none and the branch is where it was; it is no try of its own. A running job's push is left alone.
 */
export async function settlePushing(db: Db, reads: readonly { repo: string; number: number; head_oid: string }[], at: string): Promise<number> {
  const rows = await loadPushingRows(db, reads.map(({ repo, number }) => ({ repo, number })));
  if (!rows.length) return 0;
  const [made, held] = await db.together(() => Promise.all([loadMadePushes(db, rows.map(({ repo, number }) => ({ repo, number }))), loadHeldLeaseKeys(db)]));
  const heads = new Map(reads.map((r) => [`${r.repo}#${r.number}`, r.head_oid]));
  const out: PushingSettle[] = [];
  for (const r of rows) {
    const ref = `${r.repo}#${r.number}`, head = heads.get(ref)!;
    if (held.has(prLease(r.repo, r.number))) continue;
    const landed = head === r.toHead || (made.get(ref) ?? []).some((p) => (p.to === r.toHead && p.landed) || p.from === r.toHead);
    const what = r.kind === "fixup" ? "fix-up" : "CI fix";
    if (landed) out.push({ ...r, state: "pushed", reason: null, note: { repo: r.repo, number: r.number, stage: "take", at, actor: r.kind, note: `${what} pushed at ${short(r.head)}: ${r.files.join(", ")}` } });
    else if (head === r.head && r.stored) out.push({ ...r, state: "linting", reason: null, note: null });
    else out.push({ ...r, state: "superseded", reason: head === r.head ? "the push stopped before it reached GitHub" : "the branch moved before the push", note: null });
  }
  return await settlePushingRows(db, out);
}
