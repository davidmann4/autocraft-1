// Run cursor, classify state and verdict rows (M08 triage-a).
// reads: mirror.items (pruneClassifyState, through the mirror's fragment)
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { resolveKeys, type KeySource, type Ref } from "../keys.ts";
import { addAudit } from "../control/audit.ts";
import { itemsOfRepos, openItem } from "../mirror/fragments.ts";
import { inScopeExpr } from "../workflow/fragments.ts";
import { fromRow, settledOfRows } from "./settle.ts";
import type { ClassifierDuplicates, ClsRow, JevFailed, RefKey, RefereeRow, RunVerdict, Settled, VerdictInput } from "./types.ts";

const refKey = (repo: string, number: number): RefKey => `${repo}#${number}`;
const noKeys = (keys: KeySource): boolean => Array.isArray(keys) && keys.length === 0;
const push = <K, V>(m: Map<K, V[]>, k: K, v: V): void => void (m.get(k) ?? m.set(k, []).get(k)!).push(v);

const CURSOR = { kind: "current_run", repo: "", number: 0 } as const;

/** The `current_run` row's value: the run an operator set, or null. */
const setRun = (eb: kx.AnyEb) => {
  const t = kx.schemaEb(eb);
  return t.selectFrom("main.classify_state as cs").select("cs.value").where("cs.kind", "=", CURSOR.kind).where("cs.repo", "=", CURSOR.repo).where("cs.number", "=", CURSOR.number);
};

/** The run of the newest Jev or Haiku-alone verdict: one indexed lookup per classifier, the newer wins and a tie goes to Jev. */
const newestRun = (eb: kx.AnyEb) => {
  const t = kx.schemaEb(eb);
  const arm = (classifier: "jev" | "haiku", pri: number) => t.selectFrom(t.selectFrom("main.classifications").select(["run_id", "at", eb.lit(pri).as("pri")])
    .where("classifier", "=", classifier).$if(classifier === "haiku", (b) => b.where("input_hash", "is not", null)).orderBy("at", "desc").limit(1).as(`arm${pri}`)).selectAll();
  return t.selectFrom(arm("jev", 0).unionAll(arm("haiku", 1)).as("n")).select("n.run_id").orderBy("n.at", "desc").orderBy("n.pri").limit(1);
};

/** The current run as one scalar expression: the run set, else the newest verdict's. Also used by `currentRunReady`. */
export const runExpr = (eb: kx.AnyEb) => eb.fn.coalesce(eb.fn("nullif", [setRun(eb), eb.val("")]), newestRun(eb));

/** The current run: the `current_run` row, else the newest verdict run (jev rows union haiku-alone rows); one statement. */
export async function classifyRun(db: Db): Promise<string | null> {
  const q = queryDb(db);
  const row = await q.get(q.k.selectNoFrom((eb) => runExpr(eb).as("run")), { label: "triage.classifyRun" });
  return (row?.run as string | null | undefined) ?? null;
}

/** For `classify current`. */
export async function classifyRunInfo(db: Db): Promise<{ set: string | null; derived: string | null }> {
  const q = queryDb(db);
  const row = await q.get(q.k.selectNoFrom((eb) => [setRun(eb).as("set"), newestRun(eb).as("derived")]), { label: "triage.classifyRunInfo" });
  return { set: (row?.set as string | null | undefined) || null, derived: (row?.derived as string | null | undefined) ?? null };
}

/** Reads the previous run, upserts, writes the `classify-run` audit row; one `db.write`. */
export async function setClassifyRun(db: Db, run: string, by: string): Promise<{ previous: string | null }> {
  const q = queryDb(db);
  return await db.write(async () => {
    const previous = (await q.get(q.k.selectFrom("main.classify_state").select("value").where("kind", "=", CURSOR.kind).where("repo", "=", CURSOR.repo).where("number", "=", CURSOR.number)))?.value ?? null;
    await q.run(q.k.insertInto("main.classify_state").values({ ...CURSOR, value: run, at: new Date().toISOString() })
      .onConflict((oc) => oc.columns(["kind", "repo", "number"]).doUpdateSet(kx.excluded(["value", "at"]))));
    await addAudit(db, [{ login: by, action: "classify-run", target: `run:${run}`, details: { previous } }]);
    return { previous };
  });
}

/** Whether the run has any verdict row. */
export async function runHasVerdicts(db: Db, run: string): Promise<boolean> {
  const q = queryDb(db);
  return !!await q.get(q.k.selectFrom("main.classifications").select((eb) => eb.lit(1).as("one")).where("run_id", "=", run)
    .where((eb) => eb.or([eb("classifier", "=", "jev"), eb.and([eb("classifier", "=", "haiku"), eb("input_hash", "is not", null)])])).limit(1));
}

/** The `class_hash` at which a classify request got no valid Jev verdict. */
export async function loadJevFailed(db: Db, keys: KeySource): Promise<Map<RefKey, string>> {
  const out = new Map<RefKey, string>();
  if (noKeys(keys)) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.classify_state as cs").innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "cs.repo").onRef("kk.number", "=", "cs.number"))
    .select(["cs.repo", "cs.number", "cs.value"]).where("cs.kind", "=", "jev_failed"), { label: "triage.loadJevFailed" });
  for (const r of rows) if (r.value !== null) out.set(refKey(r.repo, r.number), r.value);
  return out;
}

/** Upsert on `classify_state`, one statement per 500 rows; joins the caller's transaction. Returns the items written. */
export async function markJevFailed(db: Db, rows: JevFailed[]): Promise<number> {
  if (!rows.length) return 0;
  const q = queryDb(db);
  const at = new Date().toISOString();
  const last = new Map(rows.map((r) => [refKey(r.repo, r.number), r]));
  await db.write(async () => {
    for (const part of kx.batches([...last.values()]))
      await q.run(q.k.insertInto("main.classify_state").values(part.map((r) => ({ kind: "jev_failed", repo: r.repo, number: r.number, value: r.hash, at })))
        .onConflict((oc) => oc.columns(["kind", "repo", "number"]).doUpdateSet(kx.excluded(["value", "at"]))));
  });
  return last.size;
}

/**
 * Deletes `jev_failed` rows of items no longer in the mirror or whose classify input changed since the failure (`class_hash` moved):
 * a changed item is asked again.
 */
export async function pruneClassifyState(db: Db): Promise<number> {
  const q = queryDb(db);
  const gone = (eb: kx.AnyEb) => eb.not(eb.exists(itemsOfRepos(db).whereRef("ir.repo", "=", "main.classify_state.repo" as never).whereRef("ir.number", "=", "main.classify_state.number" as never)
    .whereRef("ir.class_hash" as never, "=", "main.classify_state.value" as never)));
  return Number((await q.run((q.k as any).deleteFrom("main.classify_state").where("kind", "=", "jev_failed").where(gone))).changes);
}

const FULL = ["c.repo", "c.number", "c.classifier", "c.run_id", "c.at", "c.type_label", "c.flags", "c.probs", "c.reason", "c.input_hash"] as const;

/** The run's rows of `keys`. `slim` drops Jev's per-type probabilities and keeps `reason` only on sonnet rows (what `settle` reads). */
function verdictQuery(db: Db, keys: KeySource, run: string, slim: boolean) {
  const q = queryDb(db);
  const base = q.k.selectFrom("main.classifications as c").innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "c.repo").onRef("kk.number", "=", "c.number"));
  const sel = slim
    ? base.select(["c.repo", "c.number", "c.classifier", "c.run_id", "c.at", "c.type_label", "c.flags", "c.input_hash"]).select((eb) => [
      eb.case().when(eb.and([eb("c.classifier", "=", "jev"), kx.jsonValid(db, "c.probs")])).then(kx.jsonRemoveKey(db, "c.probs", "type")).else(eb.ref("c.probs")).end().as("probs"),
      eb.case().when("c.classifier", "=", "sonnet").then(eb.ref("c.reason")).end().as("reason"),
    ])
    : base.select(FULL);
  return sel.where("c.run_id", "=", run).orderBy("c.repo").orderBy("c.number").orderBy("c.classifier");
}

/** Verdict rows of the run; the slim form drops Jev's probabilities and keeps `reason` for sonnet rows only. */
export async function loadVerdicts(db: Db, keys: KeySource, run: string | null, o?: { slim?: boolean }): Promise<Map<RefKey, ClsRow[]>> {
  const out = new Map<RefKey, ClsRow[]>();
  if (run === null || noKeys(keys)) return out;
  const q = queryDb(db);
  for (const r of await q.all(verdictQuery(db, keys, run, !!o?.slim), { label: "triage.loadVerdicts" })) push(out, refKey(r.repo, r.number), r as ClsRow);
  return out;
}

/** The same statement as `loadVerdicts` (slim) plus the pure `settle`; an absent key means unclassified. */
export async function loadSettled(db: Db, keys: KeySource, run: string | null): Promise<Map<RefKey, Settled>> {
  const out = new Map<RefKey, Settled>();
  for (const [ref, rows] of await loadVerdicts(db, keys, run, { slim: true })) out.set(ref, settledOfRows(rows));
  return out;
}

/** Reads `item_settled` (one row per item); `alone` without `keys`. The caller has called `ensureSettled`. */
export async function loadSettledRows(db: Db, run: string, keys?: KeySource): Promise<Map<RefKey, Settled>> {
  const out = new Map<RefKey, Settled>();
  if (keys && noKeys(keys)) return out;
  const q = queryDb(db);
  const base = q.k.selectFrom("main.item_settled as s").select(["s.repo", "s.number", "s.status", "s.label", "s.source", "s.top", "s.jev_label", "s.haiku_label", "s.flags", "s.referee_label", "s.referee_sure", "s.referee_reason", "s.referee_final"])
    .where("s.run", "=", run);
  const query = keys ? base.innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "s.repo").onRef("kk.number", "=", "s.number")) as typeof base : base;
  for (const r of await q.all(query, { alone: !keys, label: "triage.loadSettledRows" })) out.set(refKey(r.repo, r.number), fromRow(r));
  return out;
}

/** Every verdict row of a run for evaluation reports. Marked `alone`. */
export async function loadRunRows(db: Db, run: string): Promise<RunVerdict[]> {
  const q = queryDb(db);
  return await q.all(q.k.selectFrom("main.classifications as c").select(FULL).where("c.run_id", "=", run).orderBy("c.repo").orderBy("c.number").orderBy("c.classifier"), { alone: true, label: "triage.loadRunRows" });
}

/** The `sonnet` rows. */
export async function loadRefereeRows(db: Db, run: string, keys: KeySource): Promise<Map<RefKey, RefereeRow>> {
  const out = new Map<RefKey, RefereeRow>();
  if (noKeys(keys)) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.classifications as c").innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "c.repo").onRef("kk.number", "=", "c.number"))
    .select(["c.repo", "c.number", "c.at", "c.type_label", "c.reason", "c.probs"]).where("c.classifier", "=", "sonnet").where("c.run_id", "=", run), { label: "triage.loadRefereeRows" });
  for (const { repo, number, ...row } of rows) out.set(refKey(repo, number), row);
  return out;
}

/** `probs.opusFailedAt` of the run's sonnet rows, only those after `after` when given. */
export async function loadRefereeFailureTimes(db: Db, run: string, after?: string): Promise<string[]> {
  const q = queryDb(db);
  const at = kx.jsonText(db, "probs", "$.opusFailedAt");
  const rows = await q.all(q.k.selectFrom("main.classifications").select(at.as("at")).where("classifier", "=", "sonnet").where("run_id", "=", run)
    .where(at, "is not", null).$if(after !== undefined, (b) => b.where(kx.bytewise(db, at), ">", after!)), { label: "triage.loadRefereeFailureTimes" });
  return rows.map((r) => r.at as string);
}

/** Legacy `dup_of` links in both directions. */
export async function loadClassifierDuplicates(db: Db, keys: KeySource): Promise<Map<RefKey, ClassifierDuplicates>> {
  const out = new Map<RefKey, ClassifierDuplicates>();
  if (noKeys(keys)) return out;
  const q = queryDb(db);
  const of = q.k.selectFrom("main.classifications as c").innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "c.repo").onRef("kk.number", "=", "c.number"))
    .select(["c.repo as repo", "c.number as item", "c.dup_of as other", (eb) => eb.val("of").as("dir")]).where("c.dup_of", "is not", null);
  const by = q.k.selectFrom("main.classifications as c").innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "c.repo").onRef("kk.number", "=", "c.dup_of"))
    .select(["c.repo as repo", "c.dup_of as item", "c.number as other", (eb) => eb.val("by").as("dir")]).where("c.dup_of", "is not", null);
  const rows = await q.all(q.k.selectFrom(of.union(by as never).as("d")).select(["d.repo", "d.item", "d.other", "d.dir"]).orderBy("d.other"), { label: "triage.loadClassifierDuplicates" });
  for (const r of rows) {
    const k = refKey(r.repo, Number(r.item));
    const d = out.get(k) ?? out.set(k, { of: [], by: [] }).get(k)!;
    (r.dir === "of" ? d.of : d.by).push(Number(r.other));
  }
  return out;
}

/** Latest row per classifier across runs (`row_number()` window). */
export async function loadLatestVerdicts(db: Db, keys: KeySource): Promise<Map<RefKey, ClsRow[]>> {
  const out = new Map<RefKey, ClsRow[]>();
  if (noKeys(keys)) return out;
  const q = queryDb(db);
  const ranked = q.k.selectFrom("main.classifications as c").innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "c.repo").onRef("kk.number", "=", "c.number"))
    .select(FULL).select((eb) => eb.fn.agg<number>("row_number").over((o) => o.partitionBy(["c.repo", "c.number", "c.classifier"]).orderBy("c.at", "desc").orderBy(kx.rowid("main.classifications", "c"), "desc")).as("rn"));
  const rows = await q.all(q.k.selectFrom(ranked.as("t")).select(["t.repo", "t.number", "t.classifier", "t.run_id", "t.at", "t.type_label", "t.flags", "t.probs", "t.reason", "t.input_hash"])
    .where("t.rn", "=", 1).orderBy("t.repo").orderBy("t.number").orderBy("t.classifier"), { label: "triage.loadLatestVerdicts" });
  for (const r of rows) push(out, refKey(r.repo, r.number), r as ClsRow);
  return out;
}

/** What the label plan reads of a classification row. */
export type LabelVerdict = Pick<ClsRow, "repo" | "number" | "classifier" | "run_id" | "at" | "type_label" | "flags" | "probs" | "input_hash">;

/** The Jev and Haiku rows of the repos' open items in the pipeline's scope (only run `run` when given), newest first per item. 1 statement. */
export async function loadLabelVerdicts(db: Db, repos: string[], run?: string): Promise<Map<RefKey, LabelVerdict[]>> {
  const out = new Map<RefKey, LabelVerdict[]>();
  if (!repos.length) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.classifications as c").select(["c.repo", "c.number", "c.classifier", "c.run_id", "c.at", "c.type_label", "c.flags", "c.probs", "c.input_hash"])
    .where(kx.inList(db, "c.repo", repos)).where("c.classifier", "in", ["jev", "haiku"])
    .where((eb) => openItem(eb, "c.repo", "c.number")).where((eb) => inScopeExpr(db, eb, "c.repo", "c.number"))
    .$if(run !== undefined, (b) => b.where("c.run_id", "=", run!)).orderBy("c.at", "desc").orderBy(kx.rowid("main.classifications", "c"), "desc"), { label: "triage.loadLabelVerdicts" });
  for (const r of rows) push(out, refKey(r.repo, r.number), r);
  return out;
}

/** Verdict count. */
export async function countVerdicts(db: Db, f: { run: string; classifier?: string; since?: string }): Promise<number> {
  const q = queryDb(db);
  const row = await q.get(q.k.selectFrom("main.classifications").select((eb) => eb.fn.countAll<number>().as("n")).where("run_id", "=", f.run)
    .$if(f.classifier !== undefined, (b) => b.where("classifier", "=", f.classifier!)).$if(f.since !== undefined, (b) => b.where("at", ">=", f.since!)), { label: "triage.countVerdicts" });
  return Number(row?.n ?? 0);
}

const KEY = ["repo", "number", "classifier", "run_id"] as const;

/**
 * Stores the rows in one write, replacing the row of each key with a new one (a new rowid, which the dashboard reads as "changed
 * since" and the settled table's triggers mark dirty). Several rows of one key: the last counts. If the batch fails each row is
 * stored on its own, and the first error is returned for the caller to throw once the rest are stored.
 */
async function storeVerdicts(db: Db, rows: readonly VerdictInput[]): Promise<{ stored: Set<RefKey>; error?: unknown }> {
  const stored = new Set<RefKey>();
  const byKey = new Map(rows.map((r) => [JSON.stringify([r.repo, r.number, r.classifier, r.run_id]), r]));
  const list = [...byKey.values()].map((r) => ({ repo: r.repo, number: r.number, classifier: r.classifier, run_id: r.run_id, at: r.at, type_label: r.type_label, flags: r.flags, probs: r.probs, reason: r.reason, input_hash: r.input_hash }));
  if (!list.length) return { stored };
  const q = queryDb(db);
  try {
    await q.attempt(() => db.write(() => kx.replaceRows(db, "main.classifications", KEY, list)));
    for (const r of list) stored.add(refKey(r.repo, r.number));
    return { stored };
  } catch (e) {
    let first: unknown = e;
    for (const r of list) {
      try {
        await q.attempt(() => db.write(() => kx.replaceRows(db, "main.classifications", KEY, [r])));
        stored.add(refKey(r.repo, r.number));
      } catch (err) {
        console.error(`classify: could not save the verdict of ${r.repo}#${r.number}: ${String((err as Error).message ?? err)}`);
        if (first === e) first = err;
      }
    }
    return first === e ? { stored } : { stored, error: first };
  }
}

/** `kx.replaceRows` on `(repo, number, classifier, run_id)`; rows get new rowids in the given order; if the batch fails each row is stored alone and the first error thrown after. */
export async function saveVerdicts(db: Db, rows: VerdictInput[]): Promise<Set<RefKey>> {
  const { stored, error } = await storeVerdicts(db, rows);
  if (error !== undefined) throw error;
  return stored;
}

/**
 * One transaction for a Jev chunk's verdict rows and `classify_state` rows. A verdict that cannot be stored is left out and its error
 * returned, not thrown: the caller throws it once the transaction it wraps this in has committed the rest.
 */
export async function saveJevChunk(db: Db, c: { verdicts: VerdictInput[]; failed: JevFailed[] }): Promise<{ stored: Set<RefKey>; error?: unknown }> {
  return await db.write(async () => {
    const res = await storeVerdicts(db, c.verdicts);
    await markJevFailed(db, c.failed);
    return res;
  });
}

/** Sets `input_hash` on the run's haiku rows and deletes the item's superseded jev rows; two statements per 500 items. */
export async function markHaikuAlone(db: Db, run: string, since: string, hashes: ReadonlyMap<RefKey, string>): Promise<RefKey[]> {
  const q = queryDb(db);
  const k = q.k as any;
  const rows = [...hashes].flatMap(([ref, hash]) => {
    const i = ref.lastIndexOf("#");
    return i > 0 ? [{ repo: ref.slice(0, i), number: Number(ref.slice(i + 1)), hash }] : [];
  });
  const updated: RefKey[] = [];
  await db.write(async () => {
    for (const part of kx.batches(rows)) {
      const v = kx.valuesTable(db, part, { repo: "text", number: "bigint", hash: "text" }, "v");
      const hit = await q.all(k.updateTable("main.classifications").from(v).set((eb: kx.AnyEb) => ({ input_hash: eb.ref("v.hash") }))
        .where((eb: kx.AnyEb) => eb.and([eb("classifications.repo", "=", eb.ref("v.repo")), eb("classifications.number", "=", eb.ref("v.number")), eb("classifications.classifier", "=", "haiku"),
          eb("classifications.run_id", "=", run), eb("classifications.at", ">=", since)]))
        .returning(["classifications.repo as repo", "classifications.number as number"])) as { repo: string; number: number }[];
      if (!hit.length) continue;
      const hitKeys = new Set(hit.map((h) => refKey(h.repo, Number(h.number))));
      updated.push(...hitKeys);
      // A Jev row of the item's earlier text goes; one without a hash (older rows) is kept, it is current until the item changes.
      const d = kx.valuesTable(db, part.filter((r) => hitKeys.has(refKey(r.repo, r.number))), { repo: "text", number: "bigint", hash: "text" }, "d");
      await q.run(k.deleteFrom("main.classifications as c").where("c.classifier", "=", "jev").where("c.run_id", "=", run).where("c.input_hash", "is not", null)
        .where((eb: kx.AnyEb) => eb.exists(kx.schemaEb(eb).selectFrom(d).select(eb.lit(1).as("one"))
          .whereRef("d.repo", "=", "c.repo" as never).whereRef("d.number", "=", "c.number" as never).whereRef("d.hash", "<>", "c.input_hash" as never))));
    }
  });
  return updated;
}

/** Reads the sonnet rows of the refs and rewrites them with `probs.opusFailures + 1` and `opusFailedAt`. Returns the rows rewritten. */
export async function recordRefereeFailures(db: Db, run: string, refs: Ref[], now: string): Promise<number> {
  if (!refs.length) return 0;
  const q = queryDb(db);
  return await db.write(async () => {
    const rows = await q.all(q.k.selectFrom("main.classifications as c").select(["c.repo", "c.number", "c.type_label", "c.reason", "c.probs", "c.at"])
      .where("c.classifier", "=", "sonnet").where("c.run_id", "=", run).where(kx.refIn(db, "c", refs.map((r) => [r.repo, r.number] as const))));
    const out = rows.map((r) => {
      let p: Record<string, unknown> = {};
      try { p = (JSON.parse(r.probs ?? "{}") as Record<string, unknown>) ?? {}; } catch { /* keep empty */ }
      p.opusFailures = (typeof p.opusFailures === "number" ? p.opusFailures : 0) + 1;
      p.opusFailedAt = now;
      return { repo: r.repo, number: r.number, classifier: "sonnet", run_id: run, at: r.at, type_label: r.type_label, flags: "[]", reason: r.reason, probs: JSON.stringify(p), input_hash: null };
    });
    await kx.replaceRows(db, "main.classifications", KEY, out);
    return out.length;
  });
}

/** Clears the run's sonnet flags, then flags the refs with `spot-check`. */
export async function markSpotCheck(db: Db, run: string, refs: Ref[]): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    await q.run(q.k.updateTable("main.classifications").set({ flags: "[]" }).where("classifier", "=", "sonnet").where("run_id", "=", run));
    for (const part of kx.chunks(refs))
      await q.run(q.k.updateTable("main.classifications").set({ flags: '["spot-check"]' }).where("classifier", "=", "sonnet").where("run_id", "=", run).where(kx.refIn(db, "main.classifications", part.map((r) => [r.repo, r.number] as const))));
  });
}
