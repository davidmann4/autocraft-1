// Stored plans and their history (`item_plans`, `item_plans_rev`, `plan_history`).
// reads: mirror.items (open, head), control.tracked_repos (hidden, tracked), review.opus_reviews (take review) through their fragments.
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { schemaEb } from "../../db/kx.ts";
import { hasTakeReview } from "../review/fragments.ts";
import { hiddenRepos, trackedRepo } from "../control/fragments.ts";
import { itemHead, openItem } from "../mirror/fragments.ts";
import { inPlanScope, keysOf, onPlanAutoPath, queuedPlan, planFixup, planGh, planScope } from "./fragments.ts";
import type { ActionKind, ItemKeys, PlanFilter, PlanHistoryEntry, PlanHistoryRow, PlanRow, PlanVersion, PlanView, RefKey, StoredPlan, StoredPlans } from "./types.ts";

const refKey = (repo: string, number: number): RefKey => `${repo}#${number}`;
const noKeys = (keys: ItemKeys): boolean => Array.isArray(keys) && keys.length === 0;
const one = (eb: kx.AnyEb) => eb.lit(1).as("one");
/** Rows per multi-row statement: well under the bound-parameter limits of both engines at a dozen columns a row. */
const BATCH_ROWS = 1000;
const batches = <T>(rows: readonly T[]): T[][] => Array.from({ length: Math.ceil(rows.length / BATCH_ROWS) }, (_, i) => rows.slice(i * BATCH_ROWS, (i + 1) * BATCH_ROWS));

type Status = PlanView["status"];
/** What a stored row contributes to the diff: its signature, and the fields that keep `since` and write history. */
type Stored = { sig: string; status: Status | undefined; state: string; wait: string | null; head: string | null };
type StoredRows = Map<RefKey, Stored>;

const sig = (r: PlanRow): string => JSON.stringify([r.kind, r.head, r.state, r.item_state, r.actions, r.wait, r.reasons, r.note, r.view]);
const storedOf = (r: PlanRow): Stored => ({ sig: sig(r), status: (JSON.parse(r.view) as Partial<PlanView>).status, state: r.state, wait: r.wait, head: r.head });

// The stored rows as of `item_plans_rev` rev, kept between passes: the table is read again only after a write this connection did
// not make. Only a commit may set it (db.afterCommit): a write joined to an outer transaction that rolls back takes the counter
// back, and another connection's writes could bring it to the memo's value with different rows.
const memo = new WeakMap<Db, { rev: number; rows: StoredRows }>();

async function planRev(db: Db): Promise<number | null> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("main.item_plans_rev").select("rev").where("id", "=", 1));
  return r ? Number(r.rev) : null;
}

async function readStored(db: Db): Promise<StoredRows> {
  const q = queryDb(db);
  const rows: StoredRows = new Map();
  for (const r of await q.all(q.k.selectFrom("main.item_plans").select(["repo", "number", "kind", "head", "state", "item_state", "actions", "wait", "reasons", "note", "view"]).$narrowType<{ kind: PlanRow["kind"] }>())) {
    rows.set(refKey(r.repo, r.number), storedOf(r));
  }
  return rows;
}

/**
 * The plan revision, and the stored rows when the per-connection memo is stale. 1 statement (the revision); the rows are a second
 * one only after a write this connection did not make. The revision is read before the rows: a write between the two leaves the
 * memo older than its revision, so the next pass reads again.
 */
export async function loadStoredPlans(db: Db): Promise<StoredPlans> {
  const rev = await planRev(db);
  const hit = memo.get(db);
  if (hit && rev !== null && hit.rev === rev) return { rev, rows: hit.rows };
  const rows = await readStored(db);
  if (rev !== null && !db.inTransaction("write")) memo.set(db, { rev, rows });
  else memo.delete(db);
  return { rev, rows };
}

export type PlanDiff = { changed: PlanRow[]; gone: string[] };

function diffRows(planned: PlanRow[], have: StoredRows): PlanDiff {
  // `since` moves only when phase or wait does; recomputing it every pass would change every row's signature.
  const next = planned.map((r) => {
    const old = have.get(refKey(r.repo, r.number))?.status;
    const v = JSON.parse(r.view) as PlanView;
    return old && old.phase === v.status.phase && old.waiting === v.status.waiting && old.since !== v.status.since ? { ...r, view: JSON.stringify({ ...v, status: { ...v.status, since: old.since } }) } : r;
  });
  const changed = next.filter((r) => have.get(refKey(r.repo, r.number))?.sig !== sig(r));
  const keep = new Set(next.map((r) => refKey(r.repo, r.number)));
  return { changed, gone: [...have.keys()].filter((k) => !keep.has(k)) };
}

/** What savePlans() would write for `planned`: the rows to upsert and the refs to delete. Pure. */
export const diffPlans = (planned: PlanRow[], stored: StoredPlans): PlanDiff => diffRows(planned, stored.rows as StoredRows);

/**
 * Diffs `planned` against the stored rows, keeps `since` while phase and wait are unchanged, writes history for changed state or wait
 * and a `gone` row per exit, upserts changed rows in chunks, deletes exited rows. Joins the pass's transaction; a quiet pass writes
 * nothing and opens none. Inside the transaction it reads the revision again (compare-and-set against `stored.rev`); on a mismatch
 * it reads every stored row under the lock and diffs again. `found`: diffPlans() of the same `stored`, when the caller has it.
 */
export async function savePlans(db: Db, planned: PlanRow[], plannedAt: string, stored?: StoredPlans, found?: PlanDiff): Promise<{ written: number; deleted: number }> {
  const first = stored ?? await loadStoredPlans(db);
  let rows = first.rows as StoredRows | null ?? await readStored(db);
  let { changed, gone } = found ?? diffRows(planned, rows);
  if (!changed.length && !gone.length) return { written: 0, deleted: 0 };
  memo.delete(db);
  const q = queryDb(db);
  const rev = await db.write(async () => {
    // A write by another connection since the rows were read is in the table but not in `rows`.
    if (await planRev(db) !== first.rev) {
      rows = await readStored(db);
      ({ changed, gone } = diffRows(planned, rows));
    }
    const have = rows;
    const history = changed.flatMap((r) => {
      const old = have.get(refKey(r.repo, r.number));
      return !old || old.state !== r.state || old.wait !== r.wait ? [{ repo: r.repo, number: r.number, head: r.head, old_state: old?.state ?? null, new_state: r.state, old_wait: old?.wait ?? null, wait: r.wait, reasons: r.reasons, at: plannedAt }] : [];
    });
    // A row for each exit, so the item's return does not read as a first plan.
    const exits = gone.map((k) => {
      const i = k.lastIndexOf("#"), old = have.get(k)!;
      return { repo: k.slice(0, i), number: Number(k.slice(i + 1)), head: old.head, old_state: old.state, new_state: "gone", old_wait: old.wait, wait: null, reasons: "[]", at: plannedAt };
    });
    for (const part of batches([...history, ...exits])) await q.run(q.k.insertInto("main.plan_history").values(part));
    for (const part of batches(changed)) {
      await q.run(q.k.insertInto("main.item_plans").values(part.map((r) => ({ repo: r.repo, number: r.number, kind: r.kind, head: r.head, state: r.state, item_state: r.item_state, actions: r.actions, wait: r.wait, reasons: r.reasons, note: r.note, view: r.view, planned_at: plannedAt })))
        .onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(kx.excluded(["kind", "head", "state", "item_state", "actions", "wait", "reasons", "note", "view", "planned_at"]))));
    }
    for (const part of kx.chunks(exits, 10_000)) await q.run(q.k.deleteFrom("main.item_plans").where(kx.tupleIn(db, ["repo", "number"], part.map((e) => [e.repo, e.number]), ["text", "bigint"])));
    // Read under the write lock: no other write can land between the rows this transaction diffed against (or wrote) and the counter.
    return await planRev(db);
  });
  if (rev !== null) {
    for (const r of changed) rows.set(refKey(r.repo, r.number), storedOf(r));
    for (const k of gone) rows.delete(k);
    // Inside an outer write, later statements of it may bump the counter again; the memo is then older than it and the next load reads.
    db.afterCommit(() => void memo.set(db, { rev, rows }));
  }
  return { written: changed.length, deleted: gone.length };
}

type PlanDbRow = { repo: string; number: number; kind: string; head: string | null; state: string; item_state: string | null; actions: string; wait: string | null; reasons: string; note: string | null; view: string; planned_at: string };
const PLAN_COLS = ["p.repo", "p.number", "p.kind", "p.head", "p.state", "p.item_state", "p.actions", "p.wait", "p.reasons", "p.note", "p.view", "p.planned_at"] as const;

const planOf = (r: PlanDbRow): StoredPlan => ({
  repo: r.repo, number: Number(r.number), kind: r.kind === "pr" ? "pr" : "issue", head: r.head, state: r.state, itemState: r.item_state,
  actions: JSON.parse(r.actions), wait: r.wait, reasons: JSON.parse(r.reasons) as string[], note: r.note, view: JSON.parse(r.view) as PlanView, plannedAt: r.planned_at,
});

/** Stored plans of `keys`. 1 statement. */
export async function loadPlans(db: Db, keys: ItemKeys): Promise<Map<RefKey, StoredPlan>> {
  const out = new Map<RefKey, StoredPlan>();
  if (noKeys(keys)) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.item_plans as p").innerJoin(keysOf(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "p.repo").onRef("kk.number", "=", "p.number")).select(PLAN_COLS));
  for (const r of rows) out.set(refKey(r.repo, r.number), planOf(r));
  return out;
}

/** Stored plans matching `filter`, in (repo, number) order. 1 statement. */
export async function listPlans(db: Db, f: PlanFilter): Promise<StoredPlan[]> {
  const q = queryDb(db);
  const gh = planGh(db, "p"), scope = planScope(db, "p");
  const rows = await q.all(q.k.selectFrom("main.item_plans as p").select(PLAN_COLS)
    .$if(!!f.repos, (b) => b.where(kx.inList(db, "p.repo", f.repos!)))
    .$if(!!f.kind, (b) => b.where("p.kind", "=", f.kind!))
    .$if(!!f.states, (b) => b.where(kx.inList(db, "p.state", f.states!)))
    .$if(!!f.queued, (b) => b.where((eb) => queuedPlan(db, eb, "p")))
    .$if(!!f.gh, (b) => b.where(kx.inList(db, gh, f.gh!)))
    .$if(f.scope !== undefined, (b) => b.where((eb) => f.scope ? inPlanScope(eb, "p") : eb.or([eb(scope, "is", null), eb(scope, "=", 0)])))
    .$if(f.auto === true, (b) => b.where((eb) => onPlanAutoPath(eb, "p")))
    .$if(!!f.fixup, (b) => b.where(planFixup(db, "p"), "=", f.fixup!))
    .$if(f.hasWait !== undefined, (b) => b.where("p.wait", f.hasWait ? "is not" : "is", null))
    .$if(!!f.action, (b) => b.where((eb) => {
      const a = f.action!;
      return eb.exists(schemaEb(eb).selectFrom(kx.jsonEach(db, "p.actions", "a")).select(one(eb)).where(kx.jsonText(db, "a.value", "$.kind"), "=", a.kind)
        .$if(a.bucket !== undefined, (s) => s.where((w) => w(w.fn.coalesce(kx.jsonText(db, "a.value", "$.params.bucket"), kx.jsonText(db, "a.value", "$.params.source")), "=", a.bucket!))));
    }))
    .$if(!!f.open, (b) => b.where((eb) => openItem(eb, "p.repo", "p.number")))
    .$if(!!f.headIsCurrent, (b) => b.where((eb) => eb("p.head", "=", itemHead(eb, "p.repo", "p.number"))))
    .$if(!!f.hidden && (!!f.hidden.visible || f.hidden.length > 0), (b) => b.where(hiddenRepos(db, "p.repo", f.hidden!)))
    .$if(!!f.after, (b) => b.where((eb) => eb.or([eb("p.repo", ">", f.after!.repo), eb.and([eb("p.repo", "=", f.after!.repo), eb("p.number", ">", f.after!.number)])])))
    .orderBy("p.repo").orderBy("p.number")
    .$if(!!f.limit, (b) => b.limit(Math.floor(f.limit!))));
  return rows.map(planOf);
}

/**
 * Refs that can be due for `kind`: plans holding an action of it, logged changes, and items with no stored plan (`pr`: open PRs and
 * merged ones with a take or take-fix review; `item`: open items), all of tracked repos for the last. Null when no plan is stored.
 * 2 statements in one wave. A stored plan stands for an item until a change is logged, and a pass stores its plans before it deletes
 * the log rows they cover, so a row read here was covered by plans read in the same snapshot.
 */
export async function loadDueRefs(db: Db, kind: ActionKind, side: "item" | "pr", repo?: string): Promise<RefKey[] | null> {
  const q = queryDb(db);
  const { k } = q;
  const [due, probe] = await db.together(() => Promise.all([
    q.all(k.selectFrom(["main.item_plans as p", kx.jsonEach(db, "p.actions", "a")]).select(["p.repo as repo", "p.number as number"])
      .where(kx.jsonText(db, "a.value", "$.kind"), "=", kind).$if(!!repo, (b) => b.where("p.repo", "=", repo!))
      .union(k.selectFrom("main.item_changes as c").select(["c.repo as repo", "c.number as number"]).$if(!!repo, (b) => b.where("c.repo", "=", repo!)))
      .union(k.selectFrom("main.items as i").select(["i.repo as repo", "i.number as number"])
        .where((eb) => trackedRepo(eb, "i.repo"))
        .$if(side === "item", (b) => b.where("i.state", "=", "OPEN"))
        .$if(side === "pr", (b) => b.where("i.kind", "=", "pr").where((eb) => eb.or([eb("i.state", "=", "OPEN"), eb.and([eb("i.state", "=", "MERGED"), hasTakeReview(eb, "i.repo", "i.number")])])))
        .$if(!!repo, (b) => b.where("i.repo", "=", repo!))
        .where((eb) => eb.not(eb.exists(schemaEb(eb).selectFrom("main.item_plans as np").select(one(eb)).where("np.repo", "=", eb.ref("i.repo")).where("np.number", "=", eb.ref("i.number"))))))),
    q.get(k.selectFrom("main.item_plans").select((eb) => eb.lit(1).as("one")).limit(1)),
  ]));
  return probe ? due.map((r) => refKey(r.repo, r.number)) : null;
}

type HistoryDbRow = { id: number; repo: string; number: number; head: string | null; old_state: string | null; new_state: string; old_wait: string | null; wait: string | null; reasons: string; at: string };
const historyOf = (r: HistoryDbRow): PlanHistoryRow => ({ id: Number(r.id), head: r.head, oldState: r.old_state, newState: r.new_state, oldWait: r.old_wait, wait: r.wait, reasons: JSON.parse(r.reasons) as string[], at: r.at });
const HISTORY_COLS = ["h.id", "h.repo", "h.number", "h.head", "h.old_state", "h.new_state", "h.old_wait", "h.wait", "h.reasons", "h.at"] as const;

/** Plan history per ref, newest first (by id); with `limit`, the newest `limit` rows of each ref. 1 statement. */
export async function loadPlanHistory(db: Db, keys: RefKey[], opts: { limit?: number } = {}): Promise<Map<RefKey, PlanHistoryRow[]>> {
  const out = new Map<RefKey, PlanHistoryRow[]>();
  if (!keys.length) return out;
  const q = queryDb(db);
  const { k } = q;
  const base = k.selectFrom("main.plan_history as h").where(kx.refIn(db, "h", keys));
  const rows = opts.limit
    ? await q.all(k.selectFrom(base.select([...HISTORY_COLS, (eb) => eb.fn.agg<number>("row_number").over((o) => o.partitionBy(["h.repo", "h.number"]).orderBy("h.id", "desc")).as("rn")]).as("t"))
      .select(["t.id", "t.repo", "t.number", "t.head", "t.old_state", "t.new_state", "t.old_wait", "t.wait", "t.reasons", "t.at"]).where("t.rn", "<=", Math.floor(opts.limit)).orderBy("t.id", "desc"))
    : await q.all(base.select(HISTORY_COLS).orderBy("h.id", "desc"));
  for (const r of rows) {
    const key = refKey(r.repo, r.number);
    (out.get(key) ?? out.set(key, []).get(key)!).push(historyOf(r));
  }
  return out;
}

/**
 * Plan history rows for the activity feed. With `afterId`, the rows after it, oldest first; without, the newest `limit` rows,
 * newest first. `since` keeps rows at or after that time. 1 statement.
 */
export async function listPlanHistory(db: Db, opts: { afterId?: number; since?: string; limit: number }): Promise<PlanHistoryEntry[]> {
  const q = queryDb(db);
  const asc = opts.afterId !== undefined;
  const rows = await q.all(q.k.selectFrom("main.plan_history as h").select(HISTORY_COLS)
    .$if(asc, (b) => b.where("h.id", ">", opts.afterId!))
    .$if(!!opts.since, (b) => b.where("h.at", ">=", opts.since!))
    .orderBy("h.id", asc ? "asc" : "desc").limit(Math.floor(opts.limit)));
  return rows.map((r) => ({ ...historyOf(r), repo: r.repo, number: Number(r.number) }));
}

/** Deletes plan history older than `keepMs`. Returns the rows removed. 1 statement. */
export async function prunePlanHistory(db: Db, keepMs: number, nowMs: number = Date.now()): Promise<number> {
  const q = queryDb(db);
  return Number((await q.run(q.k.deleteFrom("main.plan_history").where("at", "<", new Date(nowMs - keepMs).toISOString()))).changes);
}

/**
 * Plan and history fingerprints per ref for the item page's change probe. 2 statements in one wave. `historyNewest` is the newest
 * history row's id.
 */
export async function loadPlanVersions(db: Db, keys: RefKey[]): Promise<Map<RefKey, PlanVersion>> {
  const out = new Map<RefKey, PlanVersion>();
  if (!keys.length) return out;
  const q = queryDb(db);
  const { k } = q;
  const [plans, history] = await db.together(() => Promise.all([
    q.all(k.selectFrom("main.item_plans as p").select(["p.repo", "p.number", "p.planned_at", "p.state", "p.head"]).where(kx.refIn(db, "p", keys))),
    q.all(k.selectFrom("main.plan_history as h").select(["h.repo", "h.number", (eb) => eb.fn.countAll<number>().as("n"), (eb) => eb.fn.max<number | null>("h.id").as("newest")]).where(kx.refIn(db, "h", keys)).groupBy(["h.repo", "h.number"])),
  ]));
  const hist = new Map(history.map((h) => [refKey(h.repo, h.number), h]));
  for (const p of plans) {
    const h = hist.get(refKey(p.repo, p.number));
    out.set(refKey(p.repo, p.number), { plannedAt: p.planned_at, state: p.state, head: p.head, historyCount: Number(h?.n ?? 0), historyNewest: h?.newest == null ? null : Number(h.newest) });
  }
  return out;
}
