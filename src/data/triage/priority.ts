// Item priority and reach (M08 triage-a).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { namedKeys, resolveKeys, type KeySource } from "../keys.ts";
import { loadCommentStats } from "../mirror/comments.ts";
import { loadItems, loadOpenPrLinks } from "../mirror/items.ts";
import "./fragments.ts";
import { reachScore } from "./reach.ts";
import { currentRunReady } from "./settled-table.ts";
import type { Level, PriorityRow, RefKey } from "./types.ts";

const refKey = (repo: string, number: number): RefKey => `${repo}#${number}`;
const noKeys = (keys: KeySource): boolean => Array.isArray(keys) && keys.length === 0;
const DAY_MS = 86_400_000;

/** Stored priority rows. */
export async function loadPriorities(db: Db, keys: KeySource): Promise<Map<RefKey, PriorityRow>> {
  const out = new Map<RefKey, PriorityRow>();
  if (noKeys(keys)) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.item_priority as p").innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "p.repo").onRef("kk.number", "=", "p.number"))
    .select(["p.repo", "p.number", "p.impact", "p.text_hash", "p.jev_impact", "p.jev_p", "p.haiku_impact", "p.score", "p.model", "p.reason", "p.at"]), { label: "triage.loadPriorities" });
  for (const r of rows) {
    out.set(refKey(r.repo, r.number), {
      repo: r.repo, number: r.number, impact: r.impact as Level, textHash: r.text_hash, jevImpact: r.jev_impact as Level | null, jevP: r.jev_p, haikuImpact: r.haiku_impact as Level | null,
      score: r.score, model: r.model, reason: r.reason, at: r.at,
    });
  }
  return out;
}

/** Batched upsert, one statement per 500 rows; joins the caller's transaction. A row that exists keeps its reach score. Returns the refs saved. */
export async function savePriorities(db: Db, rows: PriorityRow[]): Promise<Set<RefKey>> {
  const last = new Map(rows.map((r) => [refKey(r.repo, r.number), r]));
  if (!last.size) return new Set();
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.batches([...last.values()]))
      await q.run(q.k.insertInto("main.item_priority").values(part.map((r) => ({
        repo: r.repo, number: r.number, text_hash: r.textHash, impact: r.impact, jev_impact: r.jevImpact, jev_p: r.jevP, haiku_impact: r.haikuImpact, score: r.score, model: r.model, reason: r.reason, at: r.at,
      }))).onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(kx.excluded(["text_hash", "impact", "jev_impact", "jev_p", "haiku_impact", "model", "reason", "at"]))));
  });
  return new Set(last.keys());
}

/**
 * Rereads duplicate counts, the security set, comment signals and open PR links in one wave and rewrites the reach of the rated open
 * items whose score changed with `updateFrom`; returns the number changed. The settled table is current first (`currentRunReady`).
 */
export async function rescoreReach(db: Db, nowMs: number = Date.now()): Promise<number> {
  const q = queryDb(db);
  const run = await currentRunReady(db);
  const rated = namedKeys("triage.ratedOpen", undefined);
  const [security, dups, rows, items, comments, links] = await db.together(() => Promise.all([
    run === null ? Promise.resolve([]) : q.all(q.k.selectFrom("main.item_settled").select(["repo", "number"]).where("run", "=", run).where("security", "=", 1), { label: "triage.rescoreReach.security" }),
    loadDuplicateCounts(db),
    q.all(q.k.selectFrom("main.item_priority as p").innerJoin(resolveKeys(db, rated, "kk"), (j) => j.onRef("kk.repo", "=", "p.repo").onRef("kk.number", "=", "p.number")).select(["p.repo", "p.number", "p.score"]), { label: "triage.rescoreReach.rated" }),
    loadItems(db, rated, "card", { alone: true }),
    loadCommentStats(db, rated, { kinds: ["comment"] }),
    loadOpenPrLinks(db),
  ]));
  const secure = new Set(security.map((r) => refKey(r.repo, r.number)));
  // A PR that closes issues counts for the PR and for each issue.
  const linked = new Map<RefKey, number>();
  const bump = (k: RefKey) => linked.set(k, (linked.get(k) ?? 0) + 1);
  for (const r of links) {
    let nums: unknown;
    try { nums = JSON.parse(r.closing_issues ?? "[]"); } catch { continue; }
    if (!Array.isArray(nums)) continue;
    for (const n of nums) if (typeof n === "number") { bump(refKey(r.repo, n)); bump(refKey(r.repo, r.number)); }
  }
  const changes: { repo: string; number: number; score: number }[] = [];
  for (const r of rows) {
    const k = refKey(r.repo, r.number), item = items.get(k);
    if (!item) continue;
    const created = item.created_at ? Date.parse(item.created_at) : NaN;
    const score = reachScore({
      comments: item.comments_count ?? 0, commenters: new Set((comments.get(k)?.authors ?? []).filter(Boolean)).size, linked: linked.get(k) ?? 0, duplicates: dups.get(k) ?? 0,
      security: secure.has(k), ageDays: Number.isNaN(created) ? 0 : Math.max(0, (nowMs - created) / DAY_MS),
    });
    if (score !== r.score) changes.push({ repo: r.repo, number: r.number, score });
  }
  if (!changes.length) return 0;
  await db.write(() => kx.updateFrom(db, "main.item_priority", ["repo", "number"], changes, ["score"]));
  return changes.length;
}

/** Canonical duplicate counts per item. */
export async function loadDuplicateCounts(db: Db): Promise<Map<RefKey, number>> {
  const out = new Map<RefKey, number>();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.duplicate_pairs").select(["repo", "canonical", (eb) => eb.fn.countAll<number>().as("n")])
    .where("verdict", "=", "duplicate").where("canonical", "is not", null).groupBy(["repo", "canonical"]), { label: "triage.loadDuplicateCounts" });
  for (const r of rows) {
    // The canonical item is a number in the pair's repo, or a "repo#number" ref.
    const c = String(r.canonical);
    const k = /^\d+$/.test(c) ? refKey(r.repo, Number(c)) : /^.+#\d+$/.test(c) ? c : null;
    if (k) out.set(k, (out.get(k) ?? 0) + Number(r.n));
  }
  return out;
}
