// Repository sizes (`build_sizes`) and warm gates (package build-b).
// reads: mirror.main_ci (through mirror.fragments.mainHeadsOf)
//
// Memory, first match wins: an operator's size (as it is); the history size (the median build's peak as request, the highest peak
// with headroom as limit, from the last AUTO_DAYS days of measured builds in Kubernetes environments); an OOM floor (kept under the
// history size); else the environment's. Warm target: an operator's choice, or automatic from the size of the repository's last
// published warm version.
import type { TaskResult } from "../../../web/src/api/types.ts";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { warmTmpfsBytes } from "../../build/warm-mount.ts"; // value import of a pure function (R13 exception)
import { addAudit } from "../control/index.ts";
import { mainHeadsOf } from "../mirror/fragments.ts";
import { headOf } from "./main-head.ts";
import { createTasks } from "./tasks-write.ts";
import type {
  MemorySource, NewTask, RepoSizing, SizePatch, StepMemory, WarmFacts, WarmQueueRow, WarmSource, WarmTarget,
} from "./types.ts";
import { WARM_STEP } from "./types.ts";
import { warmBytesKey, warmKeyOfRepo, warmRebuildKey } from "./warm-key.ts";

/** Measured builds the history size needs, and how far back it looks. */
export const AUTO_MIN_BUILDS = 3;
export const AUTO_BUILDS = 20;
export const AUTO_DAYS = 30;
/** The history limit: the highest peak times this, and at least this much above it (page cache and a heavier next commit). */
export const AUTO_LIMIT_FACTOR = 1.3;
export const AUTO_LIMIT_ROOM_BYTES = 2 * 1024 ** 3;
const AUTO_MIN_REQUEST_BYTES = 1024 ** 3;
/** The largest memory-backed warm target (warmTmpfsBytes of the version) the automatic choice puts in memory. */
export const AUTO_TMPFS_MAX_BYTES = 16 * 1024 ** 3;
/** History sizes are read again after this long; a write to a repo's sizes clears its entry at once. */
export const HISTORY_TTL_MS = 120_000;
/** Below every PR build; the warm environment takes no other task, so this orders only the Builds list. */
export const WARM_PRIORITY = -10;
export const WARM_TOOLCHAINS: readonly string[] = ["rust-stable"];
const MiB = 1024 ** 2;
const TARGETS: readonly string[] = ["tmpfs", "pvc", "none"];

const isTarget = (v: string | null | undefined): v is WarmTarget => TARGETS.includes(v ?? "");
const roundUp = (bytes: number): number => Math.ceil(bytes / MiB) * MiB;
const larger = (a: StepMemory, b: StepMemory): StepMemory => ({ requestBytes: Math.max(a.requestBytes, b.requestBytes), limitBytes: Math.max(a.limitBytes, b.limitBytes) });

/** The automatic warm target for a published version of `bytes`. */
export const autoWarmTarget = (bytes: number | null): WarmTarget => (!bytes ? "none" : warmTmpfsBytes(bytes) <= AUTO_TMPFS_MAX_BYTES ? "tmpfs" : "pvc");

const historyCache = new WeakMap<Db, Map<string, { at: number; v: RepoSizing["history"] }>>();
const forget = (db: Db, repos: string[]): void => { for (const r of repos) historyCache.get(db)?.delete(r); };

/**
 * A build's largest step peak, or 0 unless every planned step ran to its end: all passed, or only the last one failed (the tests).
 * A build that stopped early, timed out or was OOM-killed did not show what a whole build needs.
 */
function completedPeak(resultsJson: string, planJson: string): number {
  let results: TaskResult[], plan: { name?: unknown }[];
  try {
    results = JSON.parse(resultsJson) as TaskResult[];
    plan = JSON.parse(planJson) as { name?: unknown }[];
  } catch {
    return 0;
  }
  if (!Array.isArray(results) || !Array.isArray(plan) || !plan.length) return 0;
  const ran = plan.map((s) => results.find((x) => x?.step === s.name));
  const done = ran.every((x, i) => x && !x.timedOut && !x.oomKilled && x.exitCode !== null && (x.exitCode === 0 || i === ran.length - 1));
  return done ? Math.max(0, ...ran.map((x) => typeof x?.peakMemBytes === "number" && Number.isFinite(x.peakMemBytes) ? x.peakMemBytes : 0)) : 0;
}

function historyOf(rows: { results: string; plan: string }[]): RepoSizing["history"] {
  // One size serves every step of a task, so a build counts with its largest step.
  const peaks: number[] = [];
  for (const r of rows) {
    const p = completedPeak(r.results, r.plan);
    if (p > 0) peaks.push(p);
    if (peaks.length === AUTO_BUILDS) break;
  }
  if (peaks.length < AUTO_MIN_BUILDS) return null;
  const p = [...peaks].sort((a, b) => a - b);
  const mid = p.length >> 1;
  const median = p.length % 2 ? p[mid]! : (p[mid - 1]! + p[mid]!) / 2;
  const max = p[p.length - 1]!;
  const limit = roundUp(Math.max(max * AUTO_LIMIT_FACTOR, max + AUTO_LIMIT_ROOM_BYTES));
  return { requestBytes: Math.min(roundUp(Math.max(median, AUTO_MIN_REQUEST_BYTES)), limit), limitBytes: limit, builds: peaks.length };
}

type SizeRow = { repo: string; memory_request_bytes: number; memory_limit_bytes: number; updated_at: string; reason: string; warm_target: string; memory_source: string };

/**
 * Sizes, the memory history and `warm_bytes` of `repos`, one statement each in one wave (the history only for repos the in-process
 * cache has not read in the last two minutes). `"all"` takes every repo with a `build_sizes` row, after one more statement for them.
 * The history counts default-branch builds only (warm builds, and unpatched builds of a head the main-CI poll saw): a PR head's code
 * is not the repository's yet, and its author could make it use any amount of memory.
 */
export async function loadSizings(db: Db, repos: string[] | "all"): Promise<Map<string, RepoSizing>> {
  const q = queryDb(db);
  const { k } = q;
  let names: string[], rows: SizeRow[] | null = null;
  if (repos === "all") {
    rows = await q.all(k.selectFrom("main.build_sizes").select(kx.cols("build_sizes")));
    names = rows.map((r) => r.repo);
  } else names = [...new Set(repos)];
  names.sort();
  const out = new Map<string, RepoSizing>();
  if (!names.length) return out;
  const cache = historyCache.get(db) ?? new Map();
  historyCache.set(db, cache);
  const now = Date.now();
  const stale = names.filter((r) => !cache.has(r) || now - cache.get(r)!.at >= HISTORY_TTL_MS);
  const since = new Date(now - AUTO_DAYS * 86400_000).toISOString();
  const keys = names.map(warmKeyOfRepo);
  const [sizes, hist, bytes] = await db.together(() => Promise.all([
    rows ? Promise.resolve(rows) : q.all(k.selectFrom("main.build_sizes").select(kx.cols("build_sizes")).where(kx.inList(db, "repo", names))),
    stale.length ? q.all(k.selectFrom(k.selectFrom("main.build_tasks as t")
      .select((eb) => ["t.repo", "t.results", "t.plan", eb.fn.agg<number>("row_number").over((o) => o.partitionBy("t.repo").orderBy("t.ended_at", "desc").orderBy("t.id", "desc")).as("rn")])
      .where(kx.inList(db, "t.repo", stale)).where("t.ended_at", ">=", since).where("t.state", "in", ["done", "failed"]).where("t.results", "!=", "[]")
      .where("t.env_id", "in", k.selectFrom("main.build_envs").select("id").where("kind", "=", "kubernetes"))
      .where((w) => w.or([
        w("t.step", "=", WARM_STEP),
        w.and([w("t.number", "is", null), w("t.patch", "is", null), w("t.head_sha", "in", mainHeadsOf(w, "t.repo").clearSelect().select("mh.head_sha") as any)]),
      ])).as("h")).select(["h.repo", "h.results", "h.plan"]).where("h.rn", "<=", AUTO_BUILDS * 3).orderBy("h.repo").orderBy("h.rn")) : Promise.resolve([]),
    q.all(k.selectFrom("main.build_state").select(["key", "value"]).where(kx.inList(db, "key", keys.map(warmBytesKey)))),
  ]));
  const byRepo = new Map<string, { results: string; plan: string }[]>();
  for (const r of hist) (byRepo.get(r.repo) ?? byRepo.set(r.repo, []).get(r.repo)!).push(r);
  for (const repo of stale) cache.set(repo, { at: now, v: historyOf(byRepo.get(repo) ?? []) });
  const rowOf = new Map(sizes.map((r) => [r.repo, r]));
  const sizeOf = new Map(bytes.map((r) => [r.key.slice("warm_bytes:".length), Number(r.value)]));
  for (const repo of names) {
    const row = rowOf.get(repo), history = cache.get(repo)!.v;
    const own = row ? { requestBytes: Number(row.memory_request_bytes), limitBytes: Number(row.memory_limit_bytes) } : null;
    const [memory, memorySource]: [StepMemory | null, MemorySource] =
      own && row!.memory_source === "operator" ? [own, "operator"]
      : own && row!.memory_source === "oom" ? [history ? larger(history, own) : own, "oom"]
      : history ? [{ requestBytes: history.requestBytes, limitBytes: history.limitBytes }, "history"]
      : [null, "environment"];
    const n = sizeOf.get(warmKeyOfRepo(repo));
    const b = n !== undefined && Number.isSafeInteger(n) && n > 0 ? n : null;
    const auto = autoWarmTarget(b);
    const set = row?.warm_target;
    out.set(repo, {
      repo, memory, memorySource, history,
      warmTarget: isTarget(set) ? set : auto, warmSource: (isTarget(set) ? "operator" : "auto") satisfies WarmSource, autoWarmTarget: auto, warmBytes: b,
      updatedAt: row?.updated_at ?? null, reason: row?.reason ?? null,
    });
  }
  return out;
}

/**
 * Applies size changes with their audit rows in one transaction. A row holds one kind of change: `memory` (an operator's size, or
 * with `memorySource: "oom"` an OOM floor, which is not audited), `warmTarget` (null returns it to automatic), `reset` (memory back
 * to automatic) or `clear` (the row removed). A row left holding neither a memory nor a warm target is removed. Returns, per repo,
 * whether the change altered a row: false for a `reset` or `clear` of a repo that had nothing to reset or clear.
 */
export async function setSizes(db: Db, rows: SizePatch[], by: string): Promise<Map<string, boolean>> {
  const changed = new Map<string, boolean>();
  if (!rows.length) return changed;
  const q = queryDb(db), { k } = q;
  const last = <T extends SizePatch>(pick: (r: SizePatch) => T | undefined): T[] => [...new Map(rows.flatMap((r) => pick(r) ?? []).map((r) => [r.repo, r])).values()];
  const mem = last((r) => (r.memory ? r : undefined)), tgt = last((r) => (r.warmTarget !== undefined ? r : undefined));
  const reset = last((r) => (r.reset ? r : undefined)).map((r) => r.repo), clear = last((r) => (r.clear ? r : undefined)).map((r) => r.repo);
  await db.write(async () => {
    const at = new Date().toISOString();
    const audit: { login: string; action: string; target: string; details?: unknown }[] = [];
    for (const part of kx.batches(mem)) {
      await q.run(k.insertInto("main.build_sizes").values(part.map((r) => ({
        repo: r.repo, memory_request_bytes: r.memory!.requestBytes, memory_limit_bytes: r.memory!.limitBytes, memory_source: r.memorySource ?? "operator",
        updated_at: at, reason: r.reason ?? `set by ${by}`, warm_target: "auto",
      }))).onConflict((oc) => oc.column("repo").doUpdateSet(kx.excluded(["memory_request_bytes", "memory_limit_bytes", "memory_source", "updated_at", "reason"]))));
    }
    for (const r of mem) {
      changed.set(r.repo, true);
      if ((r.memorySource ?? "operator") === "operator") audit.push({ login: by, action: "build-size-set", target: `repo:${r.repo}`, details: r.memory });
    }
    for (const part of kx.batches(tgt)) {
      await q.run(k.insertInto("main.build_sizes").values(part.map((r) => ({
        repo: r.repo, memory_request_bytes: 0, memory_limit_bytes: 0, memory_source: "auto", updated_at: at, reason: `set by ${by}`, warm_target: r.warmTarget ?? "auto",
      }))).onConflict((oc) => oc.column("repo").doUpdateSet(kx.excluded(["warm_target", "updated_at"]))));
    }
    for (const r of tgt) {
      changed.set(r.repo, true);
      audit.push({ login: by, action: "build-warm-target-set", target: `repo:${r.repo}`, details: { warmTarget: r.warmTarget ?? "auto" } });
    }
    if (reset.length) {
      const did = await q.all(k.updateTable("main.build_sizes").set({ memory_source: "auto", memory_request_bytes: 0, memory_limit_bytes: 0, updated_at: at })
        .where(kx.inList(db, "repo", reset)).where("memory_source", "!=", "auto").returning("repo"));
      for (const r of reset) changed.set(r, did.some((d) => d.repo === r));
      for (const d of did) audit.push({ login: by, action: "build-size-auto", target: `repo:${d.repo}` });
    }
    if (clear.length) {
      const did = await q.all(k.deleteFrom("main.build_sizes").where(kx.inList(db, "repo", clear)).returning("repo"));
      for (const r of clear) changed.set(r, did.some((d) => d.repo === r));
      for (const d of did) audit.push({ login: by, action: "build-size-clear", target: `repo:${d.repo}` });
    }
    const tidy = [...new Set([...mem.map((r) => r.repo), ...tgt.map((r) => r.repo), ...reset])];
    if (tidy.length) await q.run(k.deleteFrom("main.build_sizes").where(kx.inList(db, "repo", tidy)).where("memory_source", "=", "auto").where("warm_target", "=", "auto"));
    if (audit.length) await addAudit(db, audit);
  });
  forget(db, rows.map((r) => r.repo));
  return changed;
}

/** The toolchain image of a finished warm task: its environment's (stored as `sandbox_env` JSON), else the one it was queued with. */
function ranWith(r: { sandbox_env: string | null; warm_image: string | null }, image: string): boolean {
  if (!r.sandbox_env) return !r.warm_image || r.warm_image === image;
  try {
    return (JSON.parse(r.sandbox_env) as { image?: string }).image === image;
  } catch {
    return true;
  }
}

/**
 * What the warm gates read for each of `repos`, in one wave of 4 statements: the current default-branch head (the main-CI head the
 * latest poll saw), whether a finished warm build at it counts (`attempted`), the open warm tasks, the newest warm claim and the
 * forced rebuild. A finished build counts when it was queued under `o.rev` or later; a failed one when it was queued under `o.version`
 * (each version tries a failing head once); both only for the toolchain image `o.image`.
 */
export async function loadWarmFacts(db: Db, repos: string[], o: { version: string; rev: number; image: string }): Promise<Map<string, WarmFacts>> {
  const names = [...new Set(repos)];
  const out = new Map<string, WarmFacts>();
  if (!names.length) return out;
  const q = queryDb(db), { k } = q;
  const [heads, finished, counts, forced] = await db.together(() => Promise.all([
    q.all(k.selectFrom(kx.valuesTable(db, names.map((repo) => ({ repo })), { repo: "text" }, "rr")).select((eb) => ["rr.repo as repo", headOf(eb, "rr.repo").as("head")])),
    q.all(k.selectFrom("main.build_tasks as t").select(["t.repo", "t.state", "t.sandbox_env", "t.warm_image", "t.warm_version", "t.warm_rev"])
      .where("t.step", "=", WARM_STEP).where(kx.inList(db, "t.repo", names)).where("t.state", "in", ["done", "failed"])
      .where((eb) => eb("t.head_sha", "=", headOf(eb, "t.repo")))),
    q.all(k.selectFrom("main.build_tasks").select(["repo",
        (eb) => eb.fn.sum<number>(eb.case().when("state", "in", ["queued", "claimed", "running"]).then(1).else(0).end()).as("open"),
        (eb) => eb.fn.sum<number>(eb.case().when("state", "in", ["claimed", "running"]).then(1).else(0).end()).as("active"), (eb) => eb.fn.max("claimed_at").as("newest")])
      .where("step", "=", WARM_STEP).where(kx.inList(db, "repo", names)).groupBy("repo")),
    q.all(k.selectFrom("main.build_state").select(["key", "value"]).where(kx.inList(db, "key", names.map(warmRebuildKey)))),
  ]));
  const attempted = new Set(finished.filter((r) => (r.state === "done" ? (r.warm_rev ?? 0) >= o.rev : r.warm_version === o.version) && ranWith(r, o.image)).map((r) => r.repo));
  const openOf = new Map(counts.map((r) => [r.repo, r])), claimed = new Map(counts.map((r) => [r.repo, r.newest])), force = new Map(forced.map((r) => [r.key, Number(r.value)]));
  for (const h of heads) {
    const f = openOf.get(h.repo), id = force.get(warmRebuildKey(h.repo));
    out.set(h.repo, {
      head: (h.head as string | null) ?? null, attempted: attempted.has(h.repo), open: Number(f?.open ?? 0), active: Number(f?.active ?? 0),
      newestClaimedAt: claimed.get(h.repo) ?? null, forcedTask: id !== undefined && Number.isInteger(id) ? id : null,
    });
  }
  return out;
}

/** Whether a warm build of the repo's head is to be queued: it has a head, no warm task is open, and the head was not built already (unless `force`). */
export function warmGate(f: WarmFacts, _nowMs: number, force = false): "queue" | "skip" {
  return !f.head || f.open > 0 || (!force && f.attempted) ? "skip" : "queue";
}

/**
 * The claim-time gate for the queued warm task `taskId`: it waits while another warm build of the repo runs, while the last one was
 * claimed less than `minIntervalMs` ago (a burst of merges coalesces into one publish), or when the head was built already, unless
 * this task is the forced rebuild.
 */
export function warmClaimGate(f: WarmFacts, nowMs: number, taskId: number, minIntervalMs = 15 * 60_000): "claim" | "wait" {
  if (!f.head || f.active > 0) return "wait";
  if (f.newestClaimedAt !== null && f.newestClaimedAt > new Date(nowMs - minIntervalMs).toISOString()) return "wait";
  return f.forcedTask !== taskId && f.attempted ? "wait" : "claim";
}

/** Queues one warm build per repo (the first row of a repo) and records the forced ones, in one write. Returns the task id per repo. Throws what `createTasks` throws (a full queue refuses the whole set). */
export async function queueWarmTasks(db: Db, rows: WarmQueueRow[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const uniq = [...new Map([...rows].reverse().map((r) => [r.repo, r])).values()].reverse();
  if (!uniq.length) return out;
  const q = queryDb(db);
  await db.write(async () => {
    const tasks: NewTask[] = uniq.map((r) => ({
      jobId: r.jobId, step: WARM_STEP, repo: r.repo, headSha: r.head, baseSha: r.head, requires: { os: "linux", toolchains: [...WARM_TOOLCHAINS] }, priority: WARM_PRIORITY,
      plan: r.plan, warm: { key: warmKeyOfRepo(r.repo), role: "build" }, warmImage: r.image, warmVersion: r.version, warmRev: r.rev,
    }));
    const ids = await createTasks(db, tasks);
    uniq.forEach((r, i) => out.set(r.repo, ids[i]!));
    const at = new Date().toISOString();
    const forced = uniq.filter((r) => r.force).map((r) => ({ key: warmRebuildKey(r.repo), value: String(out.get(r.repo)), updated_at: at }));
    for (const part of kx.batches(forced)) await q.run(q.k.insertInto("main.build_state").values(part).onConflict((oc) => oc.column("key").doUpdateSet(kx.excluded(["value", "updated_at"]))));
  });
  return out;
}
