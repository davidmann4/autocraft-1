// Autorepin (M11 workflow-b).
// reads: mirror.items, build.build_tasks
import type { AliasableExpression, SqlBool } from "kysely";
import type { RepinPush } from "../../core/evidence.ts";
import type { Db, Param } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import type { RepinKey, RepinPatch, RepinRequest, RepinRow, RepinState, RefKey } from "./types.ts";
import { groupBy, patchRows } from "./update.ts";

const T = "main.autorepins";
const OFFS = "main.autorepin_offs";
/** An attempt that did not finish is tried again after this long. */
const RETRY_MS = 60_000;
/** A lockfile task that has not ended this long after it was queued ends the autorepin. */
const LOCK_MAX_MS = 3 * 3600_000;
const COUNTED = ["queued", "claimed", "running"];

/**
 * An autorepin has a step to take: waiting while the dependency's pull request is no longer open (or this one is) and the retry delay
 * has passed; locking once its lockfile task ended or ran out of time; ended (pushed, failed, cancelled) while the comment is still to post.
 */
function due(eb: kx.AnyEb, now: Date): AliasableExpression<SqlBool> {
  const s = kx.schemaEb(eb);
  const one = eb.lit(1).as("one");
  const retryBefore = new Date(now.getTime() - RETRY_MS).toISOString();
  const lockBefore = new Date(now.getTime() - LOCK_MAX_MS).toISOString();
  return eb.or([
    eb.and([
      eb("a.state", "=", "waiting"),
      eb.or([eb("a.tried_at", "is", null), eb("a.tried_at", "<=", retryBefore)]),
      eb.or([
        eb.exists(s.selectFrom("main.items as i").select(one).where("i.repo", "=", eb.ref("a.ref_repo")).where("i.number", "=", eb.ref("a.ref_number")).where("i.state", "!=", "OPEN")),
        eb.not(eb.exists(s.selectFrom("main.items as i").select(one).where("i.repo", "=", eb.ref("a.repo")).where("i.number", "=", eb.ref("a.number")).where("i.kind", "=", "pr").where("i.state", "=", "OPEN"))),
      ]),
    ]),
    eb.and([
      eb("a.state", "=", "locking"),
      eb.not(eb.exists(s.selectFrom("main.build_tasks as t").select(one).where("t.id", "=", eb.ref("a.task_id")).where("t.state", "in", COUNTED).where("t.queued_at", ">", lockBefore))),
    ]),
    eb.and([eb("a.state", "in", ["pushed", "failed", "cancelled"]), eb("a.notice", "is", null)]),
  ]);
}

/**
 * Sets (or with `off`, drops) the autorepin of a pull request, as one write: the off marker (kept even when nothing waits, so an
 * older command still to be carried out does not set the row again), the cancel of rows that are `waiting` or `locking` and not newer
 * than `at` (their lockfile tasks come back in `cancelledTasks`; `cancelled` counts the rows), and the row of the pair. Throws a plain
 * Error when a later `off`, or a later command for the same repository, stands. Writes no audit row.
 */
export async function requestRepin(db: Db, r: RepinRequest): Promise<{ result: "set" | "off"; cancelledTasks: number[]; cancelled: number }> {
  const q = queryDb(db);
  const at = r.at ?? new Date().toISOString();
  return await db.write(async () => {
    if (r.off) {
      await q.run(q.k.insertInto(OFFS).values({ repo: r.repo, number: r.number, off_at: at })
        .onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(kx.excluded(["off_at"])).whereRef("excluded.off_at", ">", `${OFFS}.off_at`)));
      const gone = await q.all(q.k.updateTable(T).set({ state: "cancelled", result: null, done_at: at, requested_at: at, notice: "none" })
        .where("repo", "=", r.repo).where("number", "=", r.number).where("state", "in", ["waiting", "locking"]).where("requested_at", "<=", at)
        .returning("task_id"));
      return { result: "off" as const, cancelledTasks: gone.flatMap((g) => (g.task_id === null ? [] : [Number(g.task_id)])), cancelled: gone.length };
    }
    // Inside the write, so an off that lands between the caller's read and this write is seen.
    const off = await q.get(q.k.selectFrom(OFFS).select("off_at").where("repo", "=", r.repo).where("number", "=", r.number).where("off_at", ">", at));
    if (off) throw new Error("a later autorepin off on this pull request stands");
    const set = (await q.run(q.k.insertInto(T)
      .values({ repo: r.repo, number: r.number, ref_repo: r.refRepo, ref_number: r.refNumber, ref_branch: r.refBranch, login: r.login, github_id: r.githubId, requested_at: at, state: "waiting" })
      .onConflict((oc) => oc.columns(["repo", "number", "ref_repo"]).doUpdateSet((eb) => ({
        ref_number: eb.ref("excluded.ref_number"), ref_branch: eb.ref("excluded.ref_branch"), login: eb.ref("excluded.login"), github_id: eb.ref("excluded.github_id"),
        requested_at: eb.ref("excluded.requested_at"), state: "waiting",
        sha: null, head: null, task_id: null, tries: 0, tried_at: null, to_head: null, result: null, done_at: null, notice: null,
      })).whereRef("excluded.requested_at", ">=", `${T}.requested_at`)))).changes;
    if (!set) throw new Error("a later autorepin command for this repository on this pull request stands");
    return { result: "set" as const, cancelledTasks: [], cancelled: 0 };
  });
}

/** The autorepins with a step to take, oldest request first. */
export async function loadRepinsDue(db: Db, now: Date): Promise<RepinRow[]> {
  const q = queryDb(db);
  return await q.all(q.k.selectFrom("main.autorepins as a").select(kx.cols(T, "a")).where((eb) => due(eb, now))
    .orderBy("a.requested_at").orderBy("a.repo").orderBy("a.number")) as RepinRow[];
}

/** Existence probe for the runner tick. */
export async function hasRepinDue(db: Db, now: Date): Promise<boolean> {
  const q = queryDb(db);
  return !!await q.get(q.k.selectFrom("main.autorepins as a").select((eb) => eb.lit(1).as("one")).where((eb) => due(eb, now)).limit(1));
}

/** The commits of the pull requests' autorepins, with the head each was made on: the autorepin part of the own-push chain. They are stored before the push. */
export async function loadRepinPushes(db: Db, keys: KeySource): Promise<Map<RefKey, RepinPush[]>> {
  const out = new Map<RefKey, RepinPush[]>();
  if (Array.isArray(keys) && !keys.length) return out;
  const q = queryDb(db);
  const rows = await q.all((q.k as any).selectFrom("main.autorepins as a").innerJoin(resolveKeys(db, keys, "kk"), (j: any) => j.onRef("kk.repo", "=", "a.repo").onRef("kk.number", "=", "a.number"))
    .select(["a.repo", "a.number", "a.head", "a.to_head"]).select((eb: any) => eb.fn.coalesce("a.done_at", "a.tried_at", "a.requested_at").as("at"))
    .where("a.head", "is not", null).where("a.to_head", "is not", null)) as { repo: string; number: number; head: string; to_head: string; at: string }[];
  for (const r of rows) {
    const ref = `${r.repo}#${r.number}`;
    (out.get(ref) ?? out.set(ref, []).get(ref)!).push({ from: r.head, to: r.to_head, at: r.at });
  }
  return out;
}

/** Autorepins of the pull requests, by request time, then dependency. */
export async function loadRepins(db: Db, refs: { repo: string; number: number }[], o?: { states?: RepinState[] }): Promise<Map<RefKey, RepinRow[]>> {
  const out = new Map<RefKey, RepinRow[]>();
  if (!refs.length) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.autorepins as a").select(kx.cols(T, "a")).where(kx.refIn(db, "a", refs.map((r): [string, number] => [r.repo, r.number])))
    .$if(!!o?.states, (b) => b.where(kx.inList(db, "a.state", o!.states!)))
    .orderBy("a.requested_at").orderBy("a.ref_repo")) as RepinRow[];
  for (const r of rows) (out.get(`${r.repo}#${r.number}`) ?? out.set(`${r.repo}#${r.number}`, []).get(`${r.repo}#${r.number}`)!).push(r);
  return out;
}

/** The time of each pull request's `off` command, keyed `repo#number`. */
export async function loadRepinOffs(db: Db, refs: { repo: string; number: number }[]): Promise<Map<RefKey, string>> {
  const q = queryDb(db);
  if (!refs.length) return new Map();
  const rows = await q.all(q.k.selectFrom("main.autorepin_offs as o").select(["o.repo", "o.number", "o.off_at"]).where(kx.refIn(db, "o", refs.map((r): [string, number] => [r.repo, r.number]))));
  return new Map(rows.map((r) => [`${r.repo}#${r.number}`, r.off_at]));
}

const PATCH_TYPES: Record<keyof RepinPatch, kx.ElemType> = {
  state: "text", sha: "text", head: "text", task_id: "bigint", tries: "bigint", tried_at: "text", to_head: "text", result: "text", done_at: "text", notice: "text",
};

/**
 * Batched compare-and-set update, one statement per distinct patch column set. A row is written only while it still holds the request
 * it was read with: its pair, asker and (when given) `requestedAt`, and `expectState`. Returns the rows written.
 */
export async function saveRepins(db: Db, rows: { key: RepinKey; expectState?: RepinState; patch: RepinPatch }[]): Promise<number> {
  const live = rows.filter((r) => Object.keys(r.patch).length);
  if (!live.length) return 0;
  const shape = (r: (typeof rows)[number]) => [r.expectState !== undefined, r.key.requestedAt !== undefined, ...Object.keys(r.patch).sort()].join();
  const key: Record<string, kx.ElemType> = { repo: "text", number: "bigint", ref_repo: "text", ref_number: "bigint", login: "text" };
  return await db.write(async () => {
    let n = 0;
    for (const group of groupBy(live, shape)) {
      const first = group[0];
      const cols = Object.keys(first.patch).sort() as (keyof RepinPatch)[];
      const expect = first.expectState !== undefined, pinned = first.key.requestedAt !== undefined;
      const set = Object.fromEntries(cols.map((c) => [c, PATCH_TYPES[c]]));
      const values = group.map((r): Record<string, Param> => ({
        repo: r.key.repo, number: r.key.number, ref_repo: r.key.refRepo, ref_number: r.key.refNumber, login: r.key.login,
        ...(expect ? { expect_state: r.expectState! } : {}), ...(pinned ? { expect_requested_at: r.key.requestedAt! } : {}),
        ...Object.fromEntries(cols.map((c) => [c, (r.patch[c] ?? null) as Param])),
      }));
      n += await patchRows(db, T, key, set, values, {
        guard: { ...(expect ? { expect_state: "text" } : {}), ...(pinned ? { expect_requested_at: "text" } : {}) },
        when: (eb) => eb.and([...(expect ? [eb(`${T}.state`, "=", eb.ref("v.expect_state"))] : []), ...(pinned ? [eb(`${T}.requested_at`, "=", eb.ref("v.expect_requested_at"))] : [])]),
      });
    }
    return n;
  });
}
