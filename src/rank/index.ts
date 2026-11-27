// autocraft-server rank [show <repo> <n>]: the work rank of open items (src/rank/score.ts).
//
// Reads the stored priority, the settled classification and the changed lines; calls no model. The rank step
// writes the item_rank row of an open item in a tracked repo only when it is new or its score or breakdown changed
// (computed_at is the time the score last changed) and removes the rows of the others.
import { BULK_ROWS, bulkWrites } from "../core/plan-changes.ts";
import { currentRunReady, loadRankInputs, loadRanks, saveRanks, type RankPut } from "../data/triage/index.ts";
import { rankOf, sizeOfLines, type RankBreakdown, type RankInput, type Size } from "./score.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";

/** Size of an item: the changed lines for a PR; an issue has no size input (default). */
export function sizeOfItem(kind: string, lines: number | null): Pick<RankInput, "size" | "sizeSource"> {
  if (kind === "issue" || lines === null) return { size: null, sizeSource: "default" };
  return { size: sizeOfLines(lines), sizeSource: "lines" };
}

/** Recomputes the rank of every open item in a tracked repo. Returns the number of rows written. */
export async function runRank(db: Db, nowMs: number = Date.now()): Promise<{ items: number; changed: number; removed: number }> {
  // The settled table is brought up to date before the read that joins it.
  const { items, settled, old } = await loadRankInputs(db, await currentRunReady(db));
  const at = new Date(nowMs).toISOString();
  const keep = new Set<string>();
  const puts: RankPut[] = [];
  for (const r of items) {
    const k = `${r.repo}#${r.number}`;
    const s = settled.get(k);
    const { score, breakdown } = rankOf({ level: r.level, reach: r.reach, label: s?.label ?? null, security: s?.flags.includes("security") ?? false, ...sizeOfItem(r.kind, r.lines) });
    keep.add(k);
    const prev = old.get(k);
    if (prev && prev.score === score && JSON.stringify(prev.breakdown) === JSON.stringify(breakdown)) continue;
    puts.push({ repo: r.repo, number: r.number, score, breakdown, computedAt: at });
  }
  const dels = [...old.keys()].filter((k) => !keep.has(k)).map((k) => { const i = k.lastIndexOf("#"); return { repo: k.slice(0, i), number: Number(k.slice(i + 1)) }; });
  // Many changed rows (a first ranking, a new formula): one full-pass mark instead of a log row per item.
  const write = () => saveRanks(db, puts, dels);
  if (puts.length + dels.length >= BULK_ROWS) await bulkWrites(db, "rank", write); else await write();
  return { items: items.length, changed: puts.length, removed: dels.length };
}

export type RankRow = { repo: string; number: number; score: number; breakdown: RankBreakdown; computedAt: string };

export async function rankOfItem(db: Db, repo: string, number: number): Promise<RankRow | null> {
  const r = (await loadRanks(db, [{ repo, number }])).get(`${repo}#${number}`);
  return r ? { repo, number, ...r } : null;
}

export const commands = {
  rank: {
    summary: "rank [show <repo> <n>]: recompute the work rank of open items; show prints one item's key and its parts",
    async run(args: string[]): Promise<void> {
      const db = await openDb();
      if (args[0] === "show") {
        const repo = args[1], n = Number(args[2]);
        if (!repo || !Number.isInteger(n)) throw new Error("usage: rank show <repo> <n>");
        const r = await rankOfItem(db, repo, n);
        if (!r) { console.log(`${repo}#${n}: no rank (not open, or the rank step has not run)`); return; }
        console.log(`${repo}#${n}: ${r.score} (changed ${r.computedAt})`);
        const b = r.breakdown;
        console.log(`  level     ${b.level}${b.security ? " (raised by the security flag)" : ""}${b.rated ? "" : " (not rated yet)"}`);
        console.log(`  type      ${b.type ?? "not settled"}`);
        console.log(`  size      ${b.size} (${b.sizeSource})`);
        console.log(`  reach     ${b.reach}`);
        return;
      }
      if (args.length) throw new Error("usage: rank | rank show <repo> <n>");
      const r = await runRank(db);
      console.log(`${r.items} open items ranked, ${r.changed} changed, ${r.removed} removed`);
    },
  },
};

export type { Size };
