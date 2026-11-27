// Screenshot configs and runs (`screenshot_config`, `screenshot_runs`) (package merge-b).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { loadArtifacts, loadTasks } from "../build/index.ts";
import type { TaskRecord } from "../build/types.ts";
import { addAudit } from "../control/index.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import { itemHead, openItem } from "../mirror/fragments.ts";
import { inScopeExpr } from "../workflow/fragments.ts";
import { headOf } from "./read.ts";
import { nowIso, safeJson, settleByHead } from "./settle.ts";
import type { HeadRef, NewScreenshotRun, PendingShotRun, ScreenshotConfig, ScreenshotConfigInput, ScreenshotRun, ScreenshotSettle, VerificationTask } from "./types.ts";

type ConfigRow = { repo: string; package: string; example: string; driver: string; commands: string; ui_paths: string; size: string | null; updated_by: string; updated_at: string };

/** A stored row as a config; null when its JSON columns no longer parse. */
function configOf(r: ConfigRow): ScreenshotConfig | null {
  const commands = safeJson(r.commands), uiPaths = safeJson(r.ui_paths);
  if (typeof commands !== "object" || commands === null || !Array.isArray(uiPaths)) return null;
  return {
    package: r.package, example: r.example, driver: r.driver, commands: commands as ScreenshotConfig["commands"], ui_paths: uiPaths as string[],
    ...(r.size ? { size: r.size } : {}), repo: r.repo, updatedBy: r.updated_by, updatedAt: r.updated_at,
  };
}

/** Configs by repo (all repos when omitted). 1 statement. */
export async function loadScreenshotConfigs(db: Db, repos?: string[]): Promise<Map<string, ScreenshotConfig>> {
  if (repos && repos.length === 0) return new Map();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("screenshot_config").select(kx.cols("screenshot_config")).$if(!!repos, (s) => s.where(kx.inList(db, "repo", repos!))).orderBy("repo")) as ConfigRow[];
  const out = new Map<string, ScreenshotConfig>();
  for (const r of rows) { const c = configOf(r); if (c) out.set(r.repo, c); }
  return out;
}

/** One-key wrapper over `loadScreenshotConfigs`. */
export async function getConfig(db: Db, repo: string): Promise<ScreenshotConfig | undefined> {
  return (await loadScreenshotConfigs(db, [repo])).get(repo);
}

/** Upserts the repo's config (the caller validated it) and records the audit row in the same transaction. */
export async function saveScreenshotConfig(db: Db, by: string, repo: string, v: ScreenshotConfigInput): Promise<ScreenshotConfig> {
  const q = queryDb(db);
  const at = nowIso();
  await db.write(async () => {
    await q.run(q.k.insertInto("screenshot_config")
      .values({ repo, package: v.package, example: v.example, driver: v.driver, commands: JSON.stringify(v.commands), ui_paths: JSON.stringify(v.ui_paths), size: v.size ?? null, updated_by: by, updated_at: at })
      .onConflict((oc) => oc.column("repo").doUpdateSet(kx.excluded(["package", "example", "driver", "commands", "ui_paths", "size", "updated_by", "updated_at"]))));
    await addAudit(db, [{ login: by, action: "screenshot-config", target: repo, at, details: { package: v.package, example: v.example, driver: v.driver, commands: Object.keys(v.commands) } }]);
  });
  return { ...v, repo, updatedBy: by, updatedAt: at };
}

/** Deletes the repo's config; false when there was none. Records the audit row when one was removed. */
export async function removeScreenshotConfig(db: Db, by: string, repo: string): Promise<boolean> {
  const q = queryDb(db);
  return await db.write(async () => {
    const gone = Number((await q.run(q.k.deleteFrom("screenshot_config").where("repo", "=", repo))).changes) > 0;
    if (gone) await addAudit(db, [{ login: by, action: "screenshot-config", target: repo, details: { removed: true } }]);
    return gone;
  });
}

type RunRow = {
  repo: string; number: number; head_sha: string; base_sha: string | null; state: string; reason: string | null; plan: string | null; head_task_id: number | null;
  base_task_id: number | null; verdict: string | null; clear: number | null; comparison: string | null; model: string | null; held: number; created_at: string; finished_at: string | null;
};
const RUN_COLUMNS = ["repo", "number", "head_sha", "base_sha", "state", "reason", "plan", "head_task_id", "base_task_id", "verdict", "clear", "comparison", "model", "held", "created_at", "finished_at"] as const;
const runCols = RUN_COLUMNS.map((c) => `r.${c}` as const);

const runOf = (r: RunRow): ScreenshotRun => ({
  repo: r.repo, number: r.number, headSha: r.head_sha, baseSha: r.base_sha, state: r.state, reason: r.reason, plan: safeJson(r.plan), headTaskId: r.head_task_id,
  baseTaskId: r.base_task_id, verdict: r.verdict, clear: r.clear === null ? null : Number(r.clear) === 1, comparison: r.comparison, model: r.model,
  held: Number(r.held) === 1, createdAt: r.created_at, finishedAt: r.finished_at,
});

/** Screenshot runs of the items in `keys`, per head. 1 statement. */
export async function loadScreenshotRuns(db: Db, keys: KeySource): Promise<Map<HeadRef, ScreenshotRun>> {
  const q = queryDb(db);
  const rows = await q.all((q.k as any).selectFrom("screenshot_runs as r")
    .innerJoin(resolveKeys(db, keys, "kk"), (j: any) => j.onRef("kk.repo", "=", "r.repo").onRef("kk.number", "=", "r.number"))
    .select(runCols).orderBy("r.created_at")) as RunRow[];
  return new Map(rows.map((r) => [headOf(r.repo, r.number, r.head_sha), runOf(r)]));
}

/** Inserts runs; a head that has a run keeps it. A run that is not `planned` is finished when created. */
export async function addScreenshotRuns(db: Db, rows: NewScreenshotRun[]): Promise<void> {
  if (rows.length === 0) return;
  const q = queryDb(db);
  const byKey = new Map(rows.map((r) => [headOf(r.repo, r.number, r.headSha), r]));
  await db.write(async () => {
    for (const values of kx.batches([...byKey.values()].map((r) => ({
      repo: r.repo, number: r.number, head_sha: r.headSha, base_sha: r.baseSha, state: r.state, reason: r.reason, plan: r.plan === null || r.plan === undefined ? null : JSON.stringify(r.plan),
      head_task_id: r.headTaskId, base_task_id: r.baseTaskId, created_at: r.createdAt, finished_at: r.state === "planned" ? null : r.createdAt,
    }))))
      await q.run(q.k.insertInto("screenshot_runs").values(values).onConflict((oc) => oc.doNothing()));
  });
}

const taskOf = (role: "head" | "base", t: TaskRecord | undefined): VerificationTask | null =>
  t ? { id: t.id, role, state: t.state, plan: t.plan, results: t.results, summary: t.summary, endedAt: t.endedAt } : null;

/** Runs `planned` or `running` of PRs in scope with the item's state and head; the tasks and their artifacts come in a second wave. */
export async function loadPendingScreenshotRuns(db: Db): Promise<PendingShotRun[]> {
  const q = queryDb(db);
  const rows = await q.all((q.k as any).selectFrom("screenshot_runs as r")
    .select((eb: any) => [...runCols, openItem(eb, "r.repo", "r.number").as("is_open"), itemHead(eb, "r.repo", "r.number").as("item_head")])
    .where("r.state", "in", ["planned", "running"])
    .where((eb: any) => inScopeExpr(db, eb, "r.repo", "r.number"))
    .orderBy("r.created_at").orderBy("r.number")) as (RunRow & { is_open: unknown; item_head: string | null })[];
  const ids = [...new Set(rows.flatMap((r) => [r.head_task_id, r.base_task_id]).filter((id): id is number => id !== null))];
  const [tasks, artifacts] = ids.length ? await db.together(() => Promise.all([loadTasks(db, ids), loadArtifacts(db, ids)])) : [new Map<number, TaskRecord>(), new Map()];
  return rows.map((r) => ({
    ...runOf(r), itemState: r.is_open ? "OPEN" as const : "CLOSED" as const, currentHead: r.item_head,
    headTask: r.head_task_id === null ? null : taskOf("head", tasks.get(r.head_task_id)),
    baseTask: r.base_task_id === null ? null : taskOf("base", tasks.get(r.base_task_id)),
    headArtifacts: r.head_task_id === null ? [] : artifacts.get(r.head_task_id) ?? [],
    baseArtifacts: r.base_task_id === null ? [] : artifacts.get(r.base_task_id) ?? [],
  }));
}

const SETTLE_COLUMN = {
  state: ["state", "text"], reason: ["reason", "text"], verdict: ["verdict", "text"], clear: ["clear", "bigint"], comparison: ["comparison", "text"], model: ["model", "text"],
  held: ["held", "bigint"], finishedAt: ["finished_at", "text"], headTaskId: ["head_task_id", "bigint"], baseTaskId: ["base_task_id", "bigint"], plan: ["plan", "text"],
} as const;
const SETTLE_TYPES = Object.fromEntries(Object.values(SETTLE_COLUMN)) as Record<string, "text" | "bigint">;

/**
 * Compare-and-set: each run changes only while its state is one of `from`. A column left out of `set` keeps its value; pass null to clear
 * one. Returns the keys changed.
 */
export async function settleScreenshotRuns(db: Db, rows: ScreenshotSettle[]): Promise<Set<HeadRef>> {
  return await settleByHead(db, "screenshot_runs", SETTLE_TYPES, rows.map((r) => ({
    key: r.key, from: r.from,
    set: Object.fromEntries((Object.keys(SETTLE_COLUMN) as (keyof typeof SETTLE_COLUMN)[]).flatMap((c) => {
      const v = r.set[c];
      if (v === undefined) return [];
      const stored = typeof v === "boolean" ? (v ? 1 : 0) : c === "plan" && v !== null ? JSON.stringify(v) : (v as string | number | null);
      return [[SETTLE_COLUMN[c][0], stored]];
    })),
  })));
}

/**
 * A feature switched off: queued screenshot runs (planned or running) become `skipped`, or queued PR builds become `stale`.
 * Returns the build step whose tasks the caller cancels.
 */
export async function skipQueuedFeatureRuns(db: Db, f: "screenshots" | "pr-builds", repo?: string): Promise<{ taskSteps: string[] }> {
  const q = queryDb(db);
  const now = nowIso();
  await db.write(async () => {
    if (f === "screenshots") {
      await q.run(q.k.updateTable("screenshot_runs").set({ state: "skipped", reason: "screenshots switched off", finished_at: now })
        .where("state", "in", ["planned", "running"]).$if(!!repo, (s) => s.where("repo", "=", repo!)));
    } else {
      await q.run(q.k.updateTable("pr_builds").set({ state: "stale", finished_at: now }).where("state", "=", "queued").$if(!!repo, (s) => s.where("repo", "=", repo!)));
    }
  });
  return { taskSteps: [f === "screenshots" ? "screenshot" : "pr-build"] };
}
