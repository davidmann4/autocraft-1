// Stage limits (M06 control-b).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { GITHUB_ACTIONS } from "../../github/actions.ts";
import { itemsSumSince } from "../jobs/fragments.ts";
import { addAudit } from "./audit.ts";
import type { LimitRow, StageDefaults } from "./types.ts";

/** One row per step. A row with `limit_set = 0` only records a reset, so it takes the step default; with `defaults`, a step without a row appears with its default too. */
export async function loadStageLimits(db: Db, defaults?: StageDefaults): Promise<Map<string, LimitRow>> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.stage_limits").select(["step", "per_day", "updated_by", "updated_at", "reset_at", "limit_set"]).orderBy("step"));
  const out = new Map<string, LimitRow>();
  for (const [step, perDay] of Object.entries(defaults ?? {})) out.set(step, { step, perDay, updatedBy: null, updatedAt: null, resetAt: null });
  for (const r of rows) out.set(r.step, { step: r.step, perDay: r.limit_set === 0 ? defaults?.[r.step] ?? null : r.per_day, updatedBy: r.updated_by, updatedAt: r.updated_at, resetAt: r.reset_at });
  return out;
}

/** `step=per_day:reset_at` joined by commas, for the planner tick wave: it changes when a limit or a reset does. */
export async function limitsSignature(db: Db): Promise<string> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.stage_limits").select(["step", "per_day", "reset_at", "limit_set"]).orderBy("step"));
  return rows.map((r) => `${r.step}=${r.limit_set === 0 ? "d" : r.per_day ?? "n"}:${r.reset_at ?? ""}`).join(",");
}

/** Upsert with `limit_set = 1` plus the `stage-limit` audit row; validation stays in feature code. */
export async function setStageLimit(db: Db, step: string, perDay: number | null, by: string): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    const at = new Date().toISOString();
    await q.run(q.k.insertInto("main.stage_limits").values({ step, per_day: perDay, updated_by: by, updated_at: at, limit_set: 1 })
      .onConflict((oc) => oc.column("step").doUpdateSet(kx.excluded(["per_day", "updated_by", "updated_at", "limit_set"]))));
    await addAudit(db, [{ login: by, action: "stage-limit", target: `step:${step}`, details: { perDay }, at }]);
  });
}

/**
 * One multi-row upsert that sets `reset_at`. A step without a row gets one with `limit_set = 0` (the step default applies,
 * stored as its `per_day`); an operator's limit stays as it is. One `limit-reset` audit row: `step:<step>` for one step, else `step:all`.
 */
export async function resetLimitCounts(db: Db, steps: string[], at: string, defaults: StageDefaults, by: string): Promise<void> {
  if (!steps.length) return;
  const q = queryDb(db);
  await db.write(async () => {
    await q.run(q.k.insertInto("main.stage_limits").values(steps.map((step) => ({ step, per_day: defaults[step] ?? null, reset_at: at, limit_set: 0 })))
      .onConflict((oc) => oc.column("step").doUpdateSet(kx.excluded(["reset_at"]))));
    await addAudit(db, [{ login: by, action: "limit-reset", target: steps.length === 1 ? `step:${steps[0]}` : "step:all", details: { steps }, at }]);
  });
}

/** `per_day` of `act`, the step default when nobody set one. */
export async function loadActLimit(db: Db, defaults?: StageDefaults): Promise<number | null> {
  const q = queryDb(db);
  const row = await q.get(q.k.selectFrom("main.stage_limits").select(["per_day", "limit_set"]).where("step", "=", "act"));
  return row && row.limit_set === 1 ? row.per_day : defaults?.act ?? null;
}

/** Act job items started since `dayStart`, or since an operator reset Act's count after it, plus finished conversation-card GitHub writes since then, in one statement. */
export async function loadActUsage(db: Db, dayStart: string): Promise<number> {
  const q = queryDb(db);
  const since = (eb: kx.AnyEb) => eb.fn.coalesce(kx.schemaEb(eb).selectFrom("main.stage_limits as sl").select("sl.reset_at").where("sl.step", "=", "act").where("sl.reset_at", ">", dayStart), eb.val(dayStart));
  const r = await q.get(q.k.selectNoFrom((eb) => [
    eb.fn.coalesce(itemsSumSince(eb, "act", since(eb)), eb.lit(0)).as("jobs"),
    eb.selectFrom("main.audit").select((e) => e.fn.countAll<number>().as("n")).where((e) => e("at", ">=", since(e)))
      .where((e) => e.and([kx.like(db, "details", e.val('%"source":"conversation"%')), kx.like(db, "details", e.val('%"state":"done"%')), kx.inList(db, "action", Object.keys(GITHUB_ACTIONS))])).as("cards"),
  ]));
  return Number(r?.jobs ?? 0) + Number(r?.cards ?? 0);
}

/**
 * Finished conversation-card writes per card id, in one grouped read. A card with `since` counts only rows at or after it (a
 * card runs again after a restart, and its earlier writes are not the running ones).
 */
export async function countCardWrites(db: Db, cards: (number | { id: number; since?: string })[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!cards.length) return out;
  const since = new Map(cards.map((c) => (typeof c === "number" ? [c, ""] : [c.id, c.since ?? ""]) as [number, string]));
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.audit").select((eb) => ["at", kx.jsonNum(db, eb.case().when(kx.jsonValid(db, "details")).then(eb.ref("details")).end(), "$.card").as("card")])
    .where((eb) => {
      const d = eb.case().when(kx.jsonValid(db, "details")).then(eb.ref("details")).end();
      return eb.and([eb(kx.jsonText(db, d, "$.source"), "=", "conversation"), eb(kx.jsonText(db, d, "$.state"), "=", "done"), kx.inList(db, kx.jsonNum(db, d, "$.card"), [...since.keys()], "bigint")]);
    }));
  for (const id of since.keys()) out.set(id, 0);
  for (const r of rows) {
    const id = Number(r.card);
    if (r.at >= (since.get(id) ?? "")) out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}
