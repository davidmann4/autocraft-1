// Item rank (M08 triage-a).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { resolveKeys, type KeySource, type Ref } from "../keys.ts";
import { loadItems } from "../mirror/items.ts";
import { openItemKeys } from "../mirror/keys.ts";
import { loadSettledRows } from "./classify.ts";
import type { Level, RankBreakdown, RankInputs, RankPut, RankRow, RefKey } from "./types.ts";

const refKey = (repo: string, number: number): RefKey => `${repo}#${number}`;
const noKeys = (keys: KeySource): boolean => Array.isArray(keys) && keys.length === 0;
const isRepos = (k: KeySource | { repos: string[] }): k is { repos: string[] } => !Array.isArray(k) && "repos" in k;

/** Score, breakdown and compute time. */
export async function loadRanks(db: Db, keys: KeySource): Promise<Map<RefKey, RankRow>> {
  const out = new Map<RefKey, RankRow>();
  if (noKeys(keys)) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.item_rank as r").innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "r.repo").onRef("kk.number", "=", "r.number"))
    .select(["r.repo", "r.number", "r.score", "r.breakdown", "r.computed_at"]), { label: "triage.loadRanks" });
  for (const r of rows) out.set(refKey(r.repo, r.number), { score: r.score, breakdown: JSON.parse(r.breakdown) as RankBreakdown, computedAt: r.computed_at });
  return out;
}

/** Scores only; the weight from `item_workflows` is added by the caller. The `repos` form reads every ranked item of the repos and is `alone`. */
export async function loadRankScores(db: Db, k: KeySource | { repos: string[] }): Promise<Map<RefKey, number>> {
  const out = new Map<RefKey, number>();
  const q = queryDb(db);
  if (isRepos(k)) {
    if (!k.repos.length) return out;
    for (const r of await q.all(q.k.selectFrom("main.item_rank").select(["repo", "number", "score"]).where(kx.inList(db, "repo", k.repos)), { alone: true, label: "triage.loadRankScores" })) out.set(refKey(r.repo, r.number), r.score);
    return out;
  }
  if (noKeys(k)) return out;
  const rows = await q.all(q.k.selectFrom("main.item_rank as r").innerJoin(resolveKeys(db, k, "kk"), (j) => j.onRef("kk.repo", "=", "r.repo").onRef("kk.number", "=", "r.number")).select(["r.repo", "r.number", "r.score"]), { label: "triage.loadRankScores" });
  for (const r of rows) out.set(refKey(r.repo, r.number), r.score);
  return out;
}

/** Open tracked items with their stored level and reach, the settled rows of `run` and every stored rank, in four `alone` loads. The caller has called `ensureSettled`. */
export async function loadRankInputs(db: Db, run: string | null): Promise<RankInputs> {
  const q = queryDb(db);
  const open = openItemKeys({ tracked: true });
  const [items, prio, settled, ranks] = await db.together(() => Promise.all([
    loadItems(db, open, "pr", { alone: true }),
    q.all(q.k.selectFrom("main.item_priority as p").innerJoin(resolveKeys(db, open, "kk"), (j) => j.onRef("kk.repo", "=", "p.repo").onRef("kk.number", "=", "p.number")).select(["p.repo", "p.number", "p.impact", "p.score"]), { alone: true, label: "triage.loadRankInputs.priority" }),
    run === null ? Promise.resolve(new Map()) : loadSettledRows(db, run),
    q.all(q.k.selectFrom("main.item_rank").select(["repo", "number", "score", "breakdown"]), { alone: true, label: "triage.loadRankInputs.ranks" }),
  ]));
  const rated = new Map(prio.map((p) => [refKey(p.repo, p.number), p]));
  const rows = [...items.values()].map((i) => {
    const p = rated.get(refKey(i.repo, i.number));
    return {
      repo: i.repo, number: i.number, kind: i.kind,
      lines: i.kind === "pr" && (i.additions !== null || i.deletions !== null) ? (i.additions ?? 0) + (i.deletions ?? 0) : null,
      level: (p?.impact ?? null) as Level | null, reach: p?.score ?? null,
    };
  });
  return { items: rows, settled, old: new Map(ranks.map((r) => [refKey(r.repo, r.number), { score: r.score, breakdown: JSON.parse(r.breakdown) as RankBreakdown }])) };
}

/** Upsert one statement per 500 puts plus one delete per 500; the caller wraps it in `planner.bulkWrites` for large batches. */
export async function saveRanks(db: Db, puts: RankPut[], dels: Ref[]): Promise<{ changed: number; removed: number }> {
  const last = new Map(puts.map((p) => [refKey(p.repo, p.number), p]));
  if (!last.size && !dels.length) return { changed: 0, removed: 0 };
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.batches([...last.values()]))
      await q.run(q.k.insertInto("main.item_rank").values(part.map((p) => ({ repo: p.repo, number: p.number, score: p.score, breakdown: JSON.stringify(p.breakdown), computed_at: p.computedAt })))
        .onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(kx.excluded(["score", "breakdown", "computed_at"]))));
    for (const part of kx.batches(dels)) await q.run(q.k.deleteFrom("main.item_rank").where(kx.refIn(db, "main.item_rank", part.map((r) => [r.repo, r.number] as const))));
  });
  return { changed: last.size, removed: dels.length };
}
