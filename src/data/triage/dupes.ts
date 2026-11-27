// Duplicate pairs, scans, comparisons, drops and groups (M09 triage-b).
import type { Selectable } from "kysely";
import type { Db } from "../../db/index.ts";
import type { DB } from "../../db/types.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { retiredColumns } from "../../db/retired-names.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import type { Ref } from "../keys.ts";
import { addAudit } from "../control/audit.ts";
import { setting, writeSetting } from "../control/settings.ts";
import { loadItems, loadMergedClosures } from "../mirror/index.ts";
import { dupeEdgeRows, dupeMemberRows, onEdgeExpr, uncheckedCountRows, uncheckedPairRows } from "./cross.ts";
import type { CanonInfo, ComparisonPut, DupeGroupPut, DupeSignal, DupeState, Pair, PairKey, PairVerdictPut, RefKey, ScanContext } from "./types.ts";

const refKey = (repo: string, number: number): RefKey => `${repo}#${number}`;
const onKey = (alias: string, a: string) => (j: any) => j.onRef(`${alias}.repo`, "=", `${a}.repo`).onRef(`${alias}.number`, "=", `${a}.number`);
const now = () => new Date().toISOString();

/** The key of a stored pair in `ScanContext.stored`. */
export const pairKey = (p: { repo: string; a: number; b: number; a_hash: string; b_hash: string }): string => `${p.repo}\n${p.a}\n${p.b}\n${p.a_hash}\n${p.b_hash}`;

// ---- scan -------------------------------------------------------------------------------------------------------------

/**
 * Pairs an operator ruled on (they stop a pair of the same two items at any hash from being added again), `duplicate_scans` rows and the
 * pairs already stored, for the refs given: the scanned items of a chunk and their neighbours. One wave of three statements per 10,000 refs;
 * a pair counts only when both of its items are among the refs.
 */
export async function loadScanContext(db: Db, refs: Ref[]): Promise<ScanContext> {
  const ctx: ScanContext = { operatorPairs: [], scans: new Map(), stored: new Set() };
  const unique = [...new Map(refs.map((r) => [refKey(r.repo, r.number), [r.repo, r.number] as [string, number]])).values()];
  if (!unique.length) return ctx;
  const q = queryDb(db), k = q.k as any;
  const both = (rows: [string, number][]) => (eb: any) => eb.and([kx.tupleIn(db, ["p.repo", "p.a"], rows, ["text", "bigint"]), kx.tupleIn(db, ["p.repo", "p.b"], rows, ["text", "bigint"])]);
  const waves = await db.together(() => Promise.all(kx.chunks(unique).map((rows) => Promise.all([
    q.all(k.selectFrom("duplicate_pairs as p").select(["p.repo", "p.a", "p.b", "p.a_hash", "p.b_hash", "p.similarity", "p.by_operator"]).where(both(rows))) as Promise<(Pair & { by_operator: number })[]>,
    q.all(k.selectFrom("duplicate_scans as s").select(["s.repo", "s.number", "s.hash"]).where(kx.refIn(db, "s", rows))) as Promise<{ repo: string; number: number; hash: string }[]>,
  ]))));
  for (const [pairs, scans] of waves) {
    for (const p of pairs) {
      ctx.stored.add(pairKey(p));
      if (p.by_operator === 1) ctx.operatorPairs.push({ repo: p.repo, a: Number(p.a), b: Number(p.b), a_hash: p.a_hash, b_hash: p.b_hash, similarity: p.similarity });
    }
    for (const s of scans) ctx.scans.set(refKey(s.repo, Number(s.number)), s.hash);
  }
  return ctx;
}

/**
 * Clears the scan marks once when the scan cut-off differs from the one they were made at, so every item is scanned again at the new
 * one. Stored pairs and their verdicts stay. SQLite does the same on connect (src/db.ts); this covers Postgres. Returns whether it cleared.
 */
export async function resetScansForCutoff(db: Db, cutoff: number): Promise<boolean> {
  const key = "dupes_scan_threshold", cut = String(cutoff);
  if (await setting(db, key) === cut) return false;
  const q = queryDb(db), k = q.k as any;
  await db.write(async () => {
    await q.run(k.deleteFrom("duplicate_scans"));
    await writeSetting(db, key, cut);
  });
  return true;
}

/**
 * `INSERT ... ON CONFLICT DO NOTHING` for pairs and an upsert for scans, two statements per 500 rows, in one transaction per call. The scan
 * hash is written with the pairs and never before them. Returns the number of pairs added. The caller drops pairs an operator ruled on
 * (`loadScanContext`) first.
 */
export async function saveScans(db: Db, pairs: Pair[], scans: { repo: string; number: number; hash: string; at: string }[], at?: string): Promise<number> {
  if (!pairs.length && !scans.length) return 0;
  const q = queryDb(db), k = q.k as any;
  const created = at ?? scans[0]?.at ?? now();
  const uniquePairs = [...new Map(pairs.map((p) => [pairKey(p), p])).values()];
  const uniqueScans = [...new Map(scans.map((s) => [refKey(s.repo, s.number), s])).values()];
  return await db.write(async () => {
    let added = 0;
    for (const chunk of kx.batches(uniquePairs)) {
      added += (await q.run(k.insertInto("duplicate_pairs").values(chunk.map((p) => ({ repo: p.repo, a: p.a, b: p.b, a_hash: p.a_hash, b_hash: p.b_hash, similarity: p.similarity, created_at: created })))
        .onConflict((oc: any) => oc.doNothing()))).changes;
    }
    for (const chunk of kx.batches(uniqueScans)) {
      await q.run(k.insertInto("duplicate_scans").values(chunk.map((s) => ({ repo: s.repo, number: s.number, hash: s.hash, at: s.at })))
        .onConflict((oc: any) => oc.columns(["repo", "number"]).doUpdateSet(kx.excluded(["hash", "at"]))));
    }
    return added;
  });
}

// ---- pair check -------------------------------------------------------------------------------------------------------

/** Unchecked pairs whose items still have the hashed text and of which at least one is open, in scope, most similar first; `refs` limits to pairs of those items, no `limit` means all. */
export async function loadUncheckedPairs(db: Db, o: { limit?: number; repo?: string; refs?: KeySource } = {}): Promise<PairKey[]> {
  return await uncheckedPairRows(db, o);
}

/** The number of unchecked pairs each of `keys` is in. */
export async function loadUncheckedPairCounts(db: Db, keys: KeySource): Promise<Map<RefKey, number>> {
  return new Map((await uncheckedCountRows(db, keys)).map((r) => [refKey(r.repo, r.number), r.n]));
}

/** State, creation time and comments of each item, and the merged PR that closed it when there is one, in one wave. */
export async function loadCanonicalInfo(db: Db, refs: Ref[]): Promise<Map<RefKey, CanonInfo>> {
  if (!refs.length) return new Map();
  const repos = [...new Set(refs.map((r) => r.repo))];
  const [items, closures] = await db.together(() => Promise.all([loadItems(db, refs, "card"), loadMergedClosures(db, repos)]));
  return new Map([...items].map(([key, i]) => [key, { state: i.state, created_at: i.created_at, comments_count: i.comments_count, fixedBy: closures.get(key) ?? null }]));
}

/** One `updateFrom` on `(repo, a, b, a_hash, b_hash)` per 500 pairs. Returns the rows changed. */
export async function savePairVerdicts(db: Db, rows: PairVerdictPut[]): Promise<number> {
  if (!rows.length) return 0;
  const last = new Map(rows.map((r) => [pairKey(r), r]));
  return await db.write(async () => {
    let n = 0;
    for (const chunk of kx.batches([...last.values()])) {
      n += await kx.updateFrom(db, "duplicate_pairs", ["repo", "a", "b", "a_hash", "b_hash"], chunk.map((r) => ({
        repo: r.repo, a: r.a, b: r.b, a_hash: r.a_hash, b_hash: r.b_hash, jev_p: r.jev_p, haiku: r.haiku, verdict: r.verdict, canonical: r.canonical, checked_at: r.checked_at,
      })), ["jev_p", "haiku", "verdict", "canonical", "checked_at"]);
    }
    return n;
  });
}

// ---- comparison sets --------------------------------------------------------------------------------------------------

/** Duplicate edges, the items on their sides, stored comparisons and drops in four statements, one wave. `comparisons` and `drops` are keyed `repo\nkey`. */
export async function loadDupeState(db: Db, o: { repo?: string } = {}): Promise<DupeState> {
  const q = queryDb(db), k = q.k as any;
  const [edges, members, comparisons, drops] = await db.together(() => Promise.all([
    dupeEdgeRows(db, o.repo),
    dupeMemberRows(db, o.repo),
    q.all(k.selectFrom("dupe_comparisons").select(kx.cols("dupe_comparisons")).$if(!!o.repo, (b: any) => b.where("repo", "=", o.repo!))) as Promise<Selectable<DB["dupe_comparisons"]>[]>,
    q.all(k.selectFrom("dupe_drops").select(["repo", "key", "hash", "at"]).$if(!!o.repo, (b: any) => b.where("repo", "=", o.repo!))) as Promise<{ repo: string; key: string; hash: string; at: string }[]>,
  ]));
  return {
    edges,
    members: new Map(members.map((m) => [refKey(m.repo, Number(m.number)), m])),
    comparisons: new Map(comparisons.map((c) => [`${c.repo}\n${c.key}`, c])),
    drops: new Map(drops.map((d) => [`${d.repo}\n${d.key}`, { hash: d.hash, at: d.at }])),
  };
}

/** Upsert, 500 rows per statement; each row carries the sizes and heads its comparison read, so no member is read again. */
export async function saveComparisons(db: Db, rows: ComparisonPut[]): Promise<void> {
  if (!rows.length) return;
  const q = queryDb(db), k = q.k as any;
  const last = new Map(rows.map((r) => [`${r.repo}\n${r.key}`, r]));
  await db.write(async () => {
    for (const chunk of kx.batches([...last.values()])) {
      await q.run(k.insertInto("dupe_comparisons").values(chunk.map((c) => ({
        repo: c.repo, key: c.key, kind: c.kind, members: JSON.stringify(c.members), hash: c.hash, kept: c.kept, source: c.source, model: c.model, reason: c.reason,
        result: c.result ? JSON.stringify(c.result) : null, error: c.error, attempts: c.attempts, at: c.at, summary: c.summary, why: c.why,
        sizes: c.kind === "pr" ? JSON.stringify(c.sizes ?? {}) : null, heads: c.kind === "pr" ? JSON.stringify(c.heads ?? {}) : null,
      }))).onConflict((oc: any) => oc.columns(["repo", "key"]).doUpdateSet(kx.excluded(["kind", "members", "hash", "kept", "source", "model", "reason", "result", "error", "attempts", "at", "summary", "why", "sizes", "heads"]))));
    }
  });
}

/** Upsert into `dupe_drops`, 500 rows per statement: the set changed on GitHub since the sync and is not tried again for a while. */
export async function saveDrops(db: Db, rows: { repo: string; key: string; hash: string; at: string }[]): Promise<void> {
  if (!rows.length) return;
  const q = queryDb(db), k = q.k as any;
  const last = new Map(rows.map((r) => [`${r.repo}\n${r.key}`, r]));
  await db.write(async () => {
    for (const chunk of kx.batches([...last.values()])) {
      await q.run(k.insertInto("dupe_drops").values(chunk.map((r) => ({ repo: r.repo, key: r.key, hash: r.hash, at: r.at })))
        .onConflict((oc: any) => oc.columns(["repo", "key"]).doUpdateSet(kx.excluded(["hash", "at"]))));
    }
  });
}

/** Prefixes the hash of the repo's stored comparisons that include the item with `again:` and audits, so the next compare step compares those sets again. Returns how many it marked. */
export async function markComparisonsStale(db: Db, repo: string, number: number, by: string): Promise<number> {
  const q = queryDb(db), k = q.k as any;
  return await db.write(async () => {
    const n = (await q.run(k.updateTable("dupe_comparisons").set((eb: any) => ({ hash: eb(eb.val("again:"), "||", eb.ref("hash")) })).where("repo", "=", repo)
      .where((eb: any) => eb.not(kx.like(db, "hash", eb.val("again:%"))))
      .where((eb: any) => eb.exists(eb.selectFrom(kx.jsonEach(db, "dupe_comparisons.members", "m", "bigint")).select(eb.lit(1).as("one")).where("m.value", "=", number))))).changes;
    if (n) await addAudit(db, [{ login: by, action: "compare-again", target: refKey(repo, number), details: { sets: n } }]);
    return n;
  });
}

// ---- groups -----------------------------------------------------------------------------------------------------------

/**
 * Sole writer of `dupe_groups`: deletes the repo's members and groups, then inserts the given groups and members, 500 rows per statement.
 * `decision_id` and `base_role`/`base_target` stay filled (the group id and the role) for the readers that still use them.
 */
export async function saveDupeGroups(db: Db, repo: string, groups: DupeGroupPut[]): Promise<void> {
  const q = queryDb(db), k = q.k as any;
  const uniqueGroups = [...new Map(groups.map((g) => [g.id, g])).values()];
  const items = uniqueGroups.flatMap((g) => [...new Map(g.items.map((i) => [i.number, i])).values()].map((i) => ({ g, i })));
  await db.write(async () => {
    await q.run(k.deleteFrom("dupe_group_items").where("repo", "=", repo));
    await q.run(k.deleteFrom("dupe_groups").where("repo", "=", repo));
    for (const chunk of kx.batches(uniqueGroups)) {
      await q.run(k.insertInto("dupe_groups").values(chunk.map((g) => ({ ...retiredColumns({ decision_id: g.id }), id: g.id, repo, source: g.source }))));
    }
    for (const chunk of kx.batches(items)) {
      await q.run(k.insertInto("dupe_group_items").values(chunk.map(({ g, i }) => ({
        ...retiredColumns({ decision_id: g.id }), group_id: g.id, repo, number: i.number, kind: i.kind, role: i.role, target: i.target, detail: i.detail, base_role: i.role, base_target: i.target,
      }))));
    }
  });
}

/** The stored groups with their members, the highest id first (the one `loadDupeSignals` prefers). */
export async function loadDupeGroups(db: Db, o: { repo?: string } = {}): Promise<DupeGroupPut[]> {
  const q = queryDb(db), k = q.k as any;
  const rows = await q.all(k.selectFrom("dupe_group_items as gi").innerJoin("dupe_groups as g", "g.id", "gi.group_id")
    .select(["g.id", "g.repo", "g.source", "gi.number", "gi.kind", "gi.role", "gi.target", "gi.detail"]).$if(!!o.repo, (b: any) => b.where("g.repo", "=", o.repo!))
    .orderBy("g.id", "desc").orderBy("gi.number")) as (Omit<DupeGroupPut, "items"> & DupeGroupPut["items"][number])[];
  const out = new Map<string, DupeGroupPut>();
  for (const r of rows) {
    const g = out.get(r.id) ?? { id: r.id, repo: r.repo, source: r.source, items: [] };
    out.set(r.id, g);
    g.items.push({ number: Number(r.number), kind: r.kind, role: r.role, target: r.target === null ? null : Number(r.target), detail: r.detail });
  }
  return [...out.values()];
}

/** The item's group id, role, target and the reason of the newest comparison that covers it; none while no duplicate edge of the item holds, whatever group is stored. */
export async function loadDupeSignals(db: Db, keys: KeySource): Promise<Map<RefKey, DupeSignal>> {
  if (Array.isArray(keys) && !keys.length) return new Map();
  const q = queryDb(db), k = q.k as any;
  const rows = await q.all(k.selectFrom((eb: any) => eb.selectFrom("dupe_group_items as gi").innerJoin(resolveKeys(db, keys, "kk"), onKey("kk", "gi"))
    .leftJoin("dupe_comparisons as c", (j: any) => j.onRef("c.repo", "=", "gi.repo").onRef("c.kind", "=", "gi.kind").on((w: any) =>
      w.exists(w.selectFrom(kx.jsonEach(db, "c.members", "je", "bigint")).select(w.lit(1).as("one")).whereRef("je.value", "=", "gi.number"))))
    .where((e: any) => onEdgeExpr(db, e, "gi.repo", "gi.number"))
    .select((e: any) => ["gi.repo", "gi.number", "gi.role", "gi.target", "c.reason", "gi.group_id",
      e.fn.agg("row_number").over((o: any) => o.partitionBy(["gi.repo", "gi.number"]).orderBy("c.at", (d: any) => d.desc().nullsLast()).orderBy("gi.group_id", "desc")).as("rn")]).as("t"))
    .select(["t.repo", "t.number", "t.role", "t.target", "t.reason", "t.group_id"]).where("t.rn", "=", 1)) as { repo: string; number: number; role: string; target: number | null; reason: string | null; group_id: string }[];
  return new Map(rows.map((r) => [refKey(r.repo, Number(r.number)), { groupId: r.group_id, role: r.role as DupeSignal["role"], target: r.target === null ? null : Number(r.target), reason: r.reason }]));
}

/** The partners of each item over `duplicate` pairs (any hash), and whether the pair's canonical item is the partner. */
export async function loadDuplicatesOf(db: Db, keys: KeySource): Promise<Map<RefKey, { other: number; canonical: boolean }[]>> {
  const out = new Map<RefKey, { other: number; canonical: boolean }[]>();
  if (Array.isArray(keys) && !keys.length) return out;
  const q = queryDb(db), k = q.k as any;
  const side = (self: "a" | "b", other: "a" | "b") => k.selectFrom("duplicate_pairs as p").innerJoin(resolveKeys(db, keys, `k${self}`), (j: any) => j.onRef(`k${self}.repo`, "=", "p.repo").onRef(`k${self}.number`, "=", `p.${self}`))
    .select((eb: any) => ["p.repo", `p.${self} as number`, `p.${other} as other`, eb.case().when(eb("p.canonical", "=", eb.ref(`p.${other}`))).then(eb.lit(1)).else(eb.lit(0)).end().as("canonical")])
    .where("p.verdict", "=", "duplicate");
  const rows = await q.all(k.selectFrom(side("a", "b").unionAll(side("b", "a")).as("u")).select(["u.repo", "u.number", "u.other", "u.canonical"]).orderBy("u.repo").orderBy("u.number").orderBy("u.other")) as { repo: string; number: number; other: number; canonical: number }[];
  const seen = new Map<string, { other: number; canonical: boolean }>();
  for (const r of rows) {
    const key = refKey(r.repo, Number(r.number)), other = Number(r.other);
    const prior = seen.get(`${key}\n${other}`);
    if (prior) { prior.canonical ||= Number(r.canonical) === 1; continue; }
    const entry = { other, canonical: Number(r.canonical) === 1 };
    seen.set(`${key}\n${other}`, entry);
    (out.get(key) ?? out.set(key, []).get(key)!).push(entry);
  }
  return out;
}
