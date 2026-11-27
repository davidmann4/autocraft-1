// Push outcomes (M06 control-b).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import type { MadePush, OutcomePush } from "../../core/evidence.ts";
import { BREAKER_WINDOW, breakerTripped, classifyPush, PUSH_STAGE, requiredResult, tripKey, TRIP_STAGES, type Outcome, type Required, type TripStage } from "../../core/push-outcome.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import type { RefKey } from "../mirror/types.ts";
import { loadChecks } from "../mirror/checks.ts";
import { loadMainCi, loadMainCiAt } from "../mirror/mainci.ts";
import { closeMovedPushOutcomes, loadOpenHeadPushes } from "./cross.ts";
import { REPO_SETTINGS } from "./settings.ts";
import { tripStage } from "./trips.ts";
import type { NewOwnPush, NewPush, PushFacts, PushOutcomeRow } from "./types.ts";

/** Unresolved pushes older than this get the outcome `unknown` (the head moved on, or the checks never ran). */
const EXPIRE_MS = 3 * 24 * 3_600_000;

/** Pushes of a repo whose checks are not final yet: at most this many before the pushing steps wait for their results. */
export const UNSETTLED_PUSHES_MAX = 3;

/** Only pushes of the last 2 hours count: older ones are settled as unknown or will never settle. */
const UNSETTLED_WINDOW_MS = 2 * 3_600_000;

type CheckRow = { name: string; state: string }[];
const parse = (s: string | null | undefined): CheckRow => { try { const v = JSON.parse(s ?? "[]") as unknown; return Array.isArray(v) ? (v as CheckRow) : []; } catch { return []; } };

const isTripStage = (s: string): s is TripStage => (TRIP_STAGES as readonly string[]).includes(s);

/** The optional checks of each repo, read with the caller's other loads (a repo-scope setting per repo). */
async function loadOptionalChecks(db: Db, repos: readonly string[]): Promise<(repo: string) => string[]> {
  if (!repos.length) return () => [];
  const q = queryDb(db);
  const name = REPO_SETTINGS.optionalChecks.name;
  const rows = new Map((await q.all(q.k.selectFrom("main.settings").select(["key", "value"]).where(kx.inList(db, "key", [...new Set(repos)].map((r) => `${name}:${r}`))))).map((r) => [r.key, r.value] as const));
  return (repo) => REPO_SETTINGS.optionalChecks.read(rows.get(`${name}:${repo}`) ?? undefined) as string[];
}

/** The state of the default branch's newest head: by commit time (unknown last), then by when it was first seen. */
function latestMainState(heads: { state: string; committed_at: string | null; first_seen_at: string }[]): string | undefined {
  let best: (typeof heads)[number] | undefined;
  for (const h of heads) {
    if (!best) { best = h; continue; }
    const a = h.committed_at, b = best.committed_at;
    const newer = a !== null && b === null ? true : a === null && b !== null ? false : a !== b ? a! > b! : h.first_seen_at > best.first_seen_at;
    if (newer) best = h;
  }
  return best?.state;
}

/**
 * Records pushes that succeeded: the required-check result at the head before each (from the stored checks, when they are for
 * that head). A branch the push created has no earlier head: it takes the CI result of the commit it was built on (`base`),
 * else of the default branch's latest CI (a red or unknown baseline is no baseline for "broke"). Actions with no push stage are
 * skipped. A push is recorded once per `(repo, number, to, action)`, also across calls, in one statement.
 */
export async function addPushOutcomes(db: Db, pushes: NewPush[]): Promise<void> {
  const first = new Map<string, NewPush>();
  for (const p of pushes) if (PUSH_STAGE[p.action] && !first.has(`${p.repo}\t${p.number}\t${p.to}\t${p.action}`)) first.set(`${p.repo}\t${p.number}\t${p.to}\t${p.action}`, p);
  const list = [...first.values()];
  if (!list.length) return;
  const fresh = list.filter((p) => !p.from), moved = list.filter((p) => p.from && p.number !== null);
  const freshRepos = [...new Set(fresh.map((p) => p.repo))];
  const [ciAt, ciHeads, stored, optional] = await db.together(() => Promise.all([
    loadMainCiAt(db, fresh.filter((p) => p.base).map((p) => ({ repo: p.repo, sha: p.base! }))),
    freshRepos.length ? loadMainCi(db, { repos: freshRepos }) : Promise.resolve(new Map<string, { state: string; committed_at: string | null; first_seen_at: string }[]>()),
    loadChecks(db, moved.map((p) => ({ repo: p.repo, number: p.number! }))),
    loadOptionalChecks(db, moved.map((p) => p.repo)),
  ]));
  const now = new Date().toISOString();
  const rows = list.map((p) => {
    let before: Required | "unknown" = "unknown";
    if (!p.from) {
      const m = (p.base ? ciAt.get(`${p.repo}@${p.base}`)?.state : undefined) ?? latestMainState(ciHeads.get(p.repo) ?? []);
      before = m === "green" || m === "optional" ? "green" : m === "red" ? "red" : "unknown";
    } else if (p.number !== null) {
      const row = stored.get(`${p.repo}#${p.number}`);
      if (row && row.head_oid === p.from) before = requiredResult(parse(row.checks), optional(p.repo));
    }
    return { at: p.at ?? now, stage: PUSH_STAGE[p.action]!, action: p.action, repo: p.repo, number: p.number, from_oid: p.from, to_oid: p.to, before_res: before };
  });
  const q = queryDb(db);
  for (const part of kx.batches(rows)) {
    const v = kx.valuesTable(db, part.map((r, ord) => ({ ...r, ord })), { ord: "bigint", at: "text", stage: "text", action: "text", repo: "text", number: "bigint", from_oid: "text", to_oid: "text", before_res: "text" }, "v");
    await q.run((q.k as any).insertInto("main.push_outcomes").columns(["at", "stage", "action", "repo", "number", "from_oid", "to_oid", "before_res"])
      .expression((q.k as any).selectFrom(v).select(["v.at", "v.stage", "v.action", "v.repo", "v.number", "v.from_oid", "v.to_oid", "v.before_res"])
        .where((eb: kx.AnyEb) => eb.not(eb.exists(eb.selectFrom("main.push_outcomes as o").select(eb.lit(1).as("one"))
          .whereRef("o.repo", "=", "v.repo").where((ie) => ie("o.number", "is not distinct from", ie.ref("v.number")))
          .whereRef("o.to_oid", "=", "v.to_oid").whereRef("o.action", "=", "v.action"))))
        .orderBy("v.ord")));
  }
}

/**
 * Settles pending outcomes from freshly stored checks, closes those of closed or moved items, expires old ones, then evaluates the
 * breakers of the stages and repos that got a `broke`.
 */
export async function resolvePushes(db: Db, rows: { repo: string; number: number; head_oid: string; checks: string }[], at: string = new Date().toISOString()): Promise<void> {
  if (!rows.length) return;
  const q = queryDb(db);
  const heads = [...new Map(rows.map((r) => [`${r.repo}\n${r.head_oid}`, [r.repo, r.head_oid] as const])).values()];
  const [pendingParts, optional] = await db.together(() => Promise.all([
    Promise.all(kx.chunks(heads).map((c) => q.all(q.k.selectFrom("main.push_outcomes").select(["id", "stage", "before_res", "repo", "number", "to_oid"])
      .where("outcome", "is", null).where(kx.tupleIn(db, ["repo", "to_oid"], c, ["text", "text"])).orderBy("id")))),
    loadOptionalChecks(db, rows.map((r) => r.repo)),
  ]));
  const pending = pendingParts.flat();
  const settled: { id: number; number: number; after_res: string; outcome: Outcome; resolved_at: string }[] = [];
  const done = new Set<number>();
  const broke = new Map<string, { stage: string; repo: string }>();
  for (const r of rows) {
    // A push recorded without a number settles with the first PR at its head, as it then carries that PR's number.
    const open = pending.filter((p) => !done.has(p.id) && p.repo === r.repo && p.to_oid === r.head_oid && (p.number === r.number || p.number === null));
    if (!open.length) continue;
    const after = requiredResult(parse(r.checks), optional(r.repo));
    for (const p of open) {
      const outcome = classifyPush(p.before_res as Required | "unknown", after);
      if (outcome === null) continue;
      done.add(p.id);
      settled.push({ id: p.id, number: r.number, after_res: after, outcome, resolved_at: at });
      // A push of a retired stage (fixissue) settles but trips nothing.
      if (outcome === "broke" && isTripStage(p.stage)) broke.set(`${p.stage}\n${p.repo}`, { stage: p.stage, repo: p.repo });
    }
  }
  const old = new Date(Date.parse(at) - EXPIRE_MS).toISOString();
  await db.write(async () => {
    await kx.updateFrom(db, "push_outcomes", ["id"], settled, ["number", "after_res", "outcome", "resolved_at"]);
    await closeMovedPushOutcomes(db, at);
    await q.run(q.k.updateTable("main.push_outcomes").set({ outcome: "unknown", resolved_at: at }).where("outcome", "is", null).where("at", "<", old));
  });
  // After the settle transaction commits: the evaluation reads the newly settled outcomes.
  if (broke.size) await evaluatePushBreakers(db, [...broke.values()], at);
}

const evidenceOfPushes = (rows: { repo: string; number: number | null; to_oid: string }[]): string[] => rows.map((r) => `${r.repo}#${r.number}@${r.to_oid.slice(0, 8)}`);

type Window = { outcome: Outcome | null; repo: string; number: number | null; to_oid: string; at: string; stage: string };

/**
 * The circuit breaker for a batch: the trip rows involved and both windows of recent outcomes in one wave, the decision in
 * memory in the order of `pairs`, and one `tripStage` call. A repo's breaker trips when BREAKER_BROKE of its last BREAKER_WINDOW
 * pushes of the stage since its last resume broke a required check; the instance-wide one when the broken pushes among the stage's
 * last BREAKER_WINDOW (since its own last resume) come from 2 or more repos. A repo's own breaker has dealt with its broken
 * pushes up to its last resume, and with all of them while it is tripped: those do not count towards the instance-wide one.
 */
export async function evaluatePushBreakers(db: Db, pairs: { stage: string; repo: string }[], at: string = new Date().toISOString()): Promise<string[]> {
  const todo = pairs.filter((p): p is { stage: TripStage; repo: string } => isTripStage(p.stage));
  if (!todo.length) return [];
  const q = queryDb(db);
  const stages = [...new Set(todo.map((p) => p.stage))];
  const windowOf = (partition: "repo" | "stage", where: (eb: kx.AnyEb) => any) => q.all((q.k as any).selectFrom((sub: any) => sub.selectFrom("main.push_outcomes as p")
    .leftJoin("main.stage_trips as t", (j: any) => partition === "repo"
      ? j.on((eb: kx.AnyEb) => eb("t.stage", "=", eb(eb(eb.ref("p.stage"), "||", eb.val(":")), "||", eb.ref("p.repo"))))
      : j.onRef("t.stage", "=", "p.stage"))
    .select((eb: kx.AnyEb) => ["p.outcome as outcome", "p.repo as repo", "p.number as number", "p.to_oid as to_oid", "p.at as at", "p.stage as stage",
      eb.fn.agg<number>("row_number").over((ob: any) => (partition === "repo" ? ob.partitionBy(["p.stage", "p.repo"]) : ob.partitionBy("p.stage")).orderBy("p.id", "desc")).as("rn")])
    .where((eb: kx.AnyEb) => eb.and([where(eb), eb("p.at", ">", eb.fn.coalesce("t.cleared_at", eb.val("")))])).as("w"))
    .select(["w.outcome", "w.repo", "w.number", "w.to_oid", "w.at", "w.stage", "w.rn"]).where("w.rn", "<=", BREAKER_WINDOW).orderBy("w.stage").orderBy("w.rn")) as Promise<(Window & { rn: number })[]>;
  const [trips, repoRows, stageRows] = await db.together(() => Promise.all([
    q.all(q.k.selectFrom("main.stage_trips").select(["stage", "active", "reason", "evidence", "tripped_at", "cleared_at", "cleared_by"])
      .where((eb) => eb.or([kx.inList(db, "stage", stages), ...stages.map((s) => kx.like(db, "stage", eb.val(`${s}:%`)))]))),
    windowOf("repo", () => kx.tupleIn(db, ["p.stage", "p.repo"], todo.map((p) => [p.stage, p.repo]), ["text", "text"])),
    windowOf("stage", () => kx.inList(db, "p.stage", stages)),
  ]));
  const state = new Map<string, { active: boolean; clearedAt: string | null }>(trips.map((r) => [r.stage, { active: r.active === 1, clearedAt: r.cleared_at }]));
  const byRepo = new Map<string, Window[]>(), byStage = new Map<string, Window[]>();
  for (const r of repoRows) { const k = `${r.stage}\t${r.repo}`; (byRepo.get(k) ?? byRepo.set(k, []).get(k)!).push(r); }
  for (const r of stageRows) (byStage.get(r.stage) ?? byStage.set(r.stage, []).get(r.stage)!).push(r);
  const out: { key: string; reason: string; evidence: string[]; at: string }[] = [];
  const trip = (key: string, reason: string, evidence: string[]) => { out.push({ key, reason, evidence, at }); state.set(key, { active: true, clearedAt: state.get(key)?.clearedAt ?? null }); };
  for (const { stage, repo } of todo) {
    const key = tripKey(stage, repo);
    if (!state.get(key)?.active) {
      const rows = byRepo.get(`${stage}\t${repo}`) ?? [];
      if (breakerTripped(rows.map((r) => r.outcome))) {
        const bad = rows.filter((r) => r.outcome === "broke");
        trip(key, `${bad.length} of the last ${rows.length} ${stage} pushes in ${repo} broke a required check`, evidenceOfPushes(bad));
      }
    }
    if (state.get(stage)?.active) continue;
    const rows = byStage.get(stage) ?? [];
    const bad = rows.filter((r) => { const o = state.get(tripKey(stage, r.repo)); return r.outcome === "broke" && !o?.active && !(o?.clearedAt && r.at <= o.clearedAt); });
    const repos = [...new Set(bad.map((r) => r.repo))].sort();
    if (repos.length >= 2) trip(stage, `${bad.length} of the last ${rows.length} ${stage} pushes broke a required check, in ${repos.length} repos (${repos.join(", ")})`, evidenceOfPushes(bad));
  }
  return await tripStage(db, out);
}

/**
 * The number of pushes per repo that still wait for their required checks: the PR is open, its head is still the pushed commit,
 * the push is from the last 2 hours, and the repo has required checks (the commit's checks are pending, or none yet in a repo
 * whose pushes have settled before). The caller compares with `UNSETTLED_PUSHES_MAX`. Every repo asked for is present.
 */
export async function pushesUnsettled(db: Db, repos: string[], now: number = Date.now()): Promise<Map<string, number>> {
  const out = new Map(repos.map((r) => [r, 0]));
  if (!repos.length) return out;
  const q = queryDb(db);
  const [rows, known, optional] = await db.together(() => Promise.all([
    loadOpenHeadPushes(db, repos, new Date(now - UNSETTLED_WINDOW_MS).toISOString()),
    q.all(q.k.selectFrom("main.push_outcomes").select("repo").distinct().where(kx.inList(db, "repo", repos)).where("after_res", "in", ["green", "red"])),
    loadOptionalChecks(db, repos),
  ]));
  const settledBefore = new Set(known.map((r) => r.repo));
  for (const r of rows) {
    const res = requiredResult(parse(r.checks), optional(r.repo));
    if (res === "pending" || (res === "none" && settledBefore.has(r.repo))) out.set(r.repo, (out.get(r.repo) ?? 0) + 1);
  }
  return out;
}

const keysJoin = (db: Db, keys: { repo: string; number: number }[] | KeySource) => resolveKeys(db, keys as KeySource, "kk");

const isEmptyKeys = (keys: unknown): boolean => Array.isArray(keys) && keys.length === 0;

const outcomePush = (r: { from_oid: string; to_oid: string; action: string; at: string }): OutcomePush => ({ from: r.from_oid, to: r.to_oid, action: r.action, at: r.at });

/**
 * Per PR: the heads we pushed or moved off (`to_oid` and `from_oid`), when each head was moved off (the latest push away from it),
 * and the head our latest push broke (`outcome = 'broke'`, last by id).
 */
export async function loadPushFacts(db: Db, keys: { repo: string; number: number }[] | KeySource): Promise<Map<RefKey, PushFacts>> {
  const out = new Map<RefKey, PushFacts>();
  if (isEmptyKeys(keys)) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.push_outcomes as p").innerJoin(keysJoin(db, keys), (j) => j.onRef("kk.repo", "=", "p.repo").onRef("kk.number", "=", "p.number"))
    .select(["p.repo as repo", "p.number as number", "p.from_oid as from_oid", "p.to_oid as to_oid", "p.at as at", "p.outcome as outcome", "p.action as action"]).orderBy("p.id"));
  for (const r of rows) {
    const ref = `${r.repo}#${r.number}`;
    const f = out.get(ref) ?? out.set(ref, { pushed: new Set(), movedOffAt: new Map(), moves: [], brokeHead: null }).get(ref)!;
    f.pushed.add(r.to_oid);
    if (r.from_oid !== null) {
      f.pushed.add(r.from_oid);
      f.moves.push(outcomePush({ ...r, from_oid: r.from_oid }));
      if (r.to_oid !== r.from_oid && r.at > (f.movedOffAt.get(r.from_oid) ?? "")) f.movedOffAt.set(r.from_oid, r.at);
    }
    if (r.outcome === "broke") f.brokeHead = r.to_oid;
  }
  return out;
}

/** The recorded pushes of each PR that name the head they were made on, oldest first: the push-outcome part of the own-push chain. */
export async function loadPushOutcomeEdges(db: Db, keys: { repo: string; number: number }[] | KeySource): Promise<Map<RefKey, OutcomePush[]>> {
  const out = new Map<RefKey, OutcomePush[]>();
  if (isEmptyKeys(keys)) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.push_outcomes as p").innerJoin(keysJoin(db, keys), (j) => j.onRef("kk.repo", "=", "p.repo").onRef("kk.number", "=", "p.number"))
    .select(["p.repo as repo", "p.number as number", "p.from_oid as from_oid", "p.to_oid as to_oid", "p.action as action", "p.at as at"]).where("p.from_oid", "is not", null).orderBy("p.id"));
  for (const r of rows) {
    const ref = `${r.repo}#${r.number}`;
    (out.get(ref) ?? out.set(ref, []).get(ref)!).push(outcomePush({ ...r, from_oid: r.from_oid! }));
  }
  return out;
}

/** Records a push to a pull request right before it is made. The same commit tried again after a try that did not land takes the new try's time. */
export async function addOwnPush(db: Db, p: NewOwnPush, at: string = new Date().toISOString()): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.own_pushes").values({ repo: p.repo, number: p.number, from_oid: p.from, to_oid: p.to, action: p.action, at, lines: p.lines })
    .onConflict((oc) => oc.columns(["repo", "number", "to_oid"]).doUpdateSet({ at }).where("main.own_pushes.landed_at", "is", null)));
}

/** The push recorded by `addOwnPush` is done. */
export async function landOwnPush(db: Db, p: Pick<NewOwnPush, "repo" | "number" | "to">, at: string = new Date().toISOString()): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.updateTable("main.own_pushes").set({ landed_at: at }).where("repo", "=", p.repo).where("number", "=", p.number).where("to_oid", "=", p.to).where("landed_at", "is", null));
}

/** The recorded pushes of each PR, landed or not. */
export async function loadMadePushes(db: Db, keys: KeySource): Promise<Map<RefKey, MadePush[]>> {
  const out = new Map<RefKey, MadePush[]>();
  if (isEmptyKeys(keys)) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.own_pushes as p").innerJoin(keysJoin(db, keys), (j) => j.onRef("kk.repo", "=", "p.repo").onRef("kk.number", "=", "p.number"))
    .select(["p.repo as repo", "p.number as number", "p.from_oid as from_oid", "p.to_oid as to_oid", "p.action as action", "p.at as at", "p.lines as lines", "p.landed_at as landed_at"]).orderBy("p.at"));
  for (const r of rows) {
    const ref = `${r.repo}#${r.number}`;
    (out.get(ref) ?? out.set(ref, []).get(ref)!).push({ from: r.from_oid, to: r.to_oid, action: r.action, at: r.at, lines: r.lines === null ? null : Number(r.lines), landed: r.landed_at !== null });
  }
  return out;
}

/** Read model for the trace and activity pages: newest first. */
export async function listPushOutcomes(db: Db, f: { refs?: string[]; since?: string; limit?: number }): Promise<PushOutcomeRow[]> {
  if (f.refs && !f.refs.length) return [];
  const q = queryDb(db);
  let s = q.k.selectFrom("main.push_outcomes").select(kx.cols("push_outcomes"))
    .$if(!!f.refs, (b) => b.where(kx.refIn(db, "push_outcomes", f.refs!)))
    .$if(f.since !== undefined, (b) => b.where("at", ">=", f.since!)).orderBy("id", "desc");
  if (f.limit !== undefined) s = s.limit(f.limit);
  return await q.all(s);
}

/** Per item: rows, newest id, whether every outcome is settled, and how many are (the fingerprint changes with each settle). */
export async function countPushOutcomes(db: Db, refs: string[]): Promise<Map<string, { n: number; newest: number; done: boolean; settled: number }>> {
  const out = new Map<string, { n: number; newest: number; done: boolean; settled: number }>();
  if (!refs.length) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.push_outcomes").select((eb) => ["repo", "number", eb.fn.countAll<number>().as("n"), eb.fn.max<number>("id").as("newest"),
    eb.fn.sum<number>(eb.case().when("outcome", "is not", null).then(eb.lit(1)).else(eb.lit(0)).end()).as("settled")])
    .where(kx.refIn(db, "push_outcomes", refs)).groupBy(["repo", "number"]));
  for (const r of rows) out.set(`${r.repo}#${r.number}`, { n: Number(r.n), newest: Number(r.newest), done: Number(r.settled) === Number(r.n), settled: Number(r.settled) });
  return out;
}
