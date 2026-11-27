// Build environments (`build_envs`) (package build-a).
import { createHash, timingSafeEqual } from "node:crypto";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { addAudit } from "../control/index.ts";
import type { NewAudit } from "../control/types.ts";
import { ENV_COLUMNS, toEnv, toEnvTask, type EnvDbRow, type RunningRow } from "./rows.ts";
import { StatusError } from "./types.ts";
import type { EnvPatch, EnvRecord, EnvTask } from "./types.ts";

const hashOf = (key: string): string => createHash("sha256").update(key).digest("hex");
const DUMMY_HASH = hashOf("no such environment");
const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));

/** Environments in registration order with their claimed and running tasks. 2 statements in one wave. */
export async function loadEnvs(db: Db, opt?: { ids?: string[]; kind?: string; enabled?: boolean; nowMs?: number }): Promise<EnvRecord[]> {
  if (opt?.ids && opt.ids.length === 0) return [];
  const q = queryDb(db);
  const [envs, running] = await db.together(async () => await Promise.all([
    q.all(q.k.selectFrom("build_envs as e").select(ENV_COLUMNS)
      .$if(!!opt?.ids, (s) => s.where(kx.inList(db, "e.id", opt!.ids!)))
      .$if(!!opt?.kind, (s) => s.where("e.kind", "=", opt!.kind!))
      .$if(opt?.enabled !== undefined, (s) => s.where("e.enabled", "=", opt!.enabled ? 1 : 0))
      .orderBy("e.created_at").orderBy("e.id"), { label: "build.loadEnvs" }),
    q.all(q.k.selectFrom("build_tasks").select(["id", "env_id", "step", "repo", "number", "plan", "results", "started_at", "claimed_at"]).where("state", "in", ["claimed", "running"])
      .$if(!!opt?.ids, (s) => s.where(kx.inList(db, "env_id", opt!.ids!))).orderBy("id"), { label: "build.loadEnvs" }),
  ]));
  const by = new Map<string, EnvTask[]>();
  for (const t of running as RunningRow[]) if (t.env_id) (by.get(t.env_id) ?? by.set(t.env_id, []).get(t.env_id)!).push(toEnvTask(t));
  const nowMs = opt?.nowMs ?? Date.now();
  return (envs as EnvDbRow[]).map((r) => toEnv(r, by.get(r.id) ?? [], nowMs));
}

/**
 * The environment a bearer key belongs to, or null; a pod key (`cwp_<task id>_...`) also names its one task. The comparison takes the
 * same time for a wrong key and an unknown id. 1 statement.
 */
export async function authenticateEnv(db: Db, key: string): Promise<{ id: string; taskId?: number } | null> {
  if (key.length > 200) return null;
  const m = /^cwk_([a-z0-9-]{3,32})_[A-Za-z0-9_-]{20,100}$/.exec(key);
  const p = m ? null : /^cwp_(\d{1,15})_[A-Za-z0-9_-]{20,100}$/.exec(key);
  const q = queryDb(db);
  const row = m
    ? await q.get(q.k.selectFrom("build_envs").select(["id", "key_hash"]).where("id", "=", m[1]!).where("kind", "!=", "kubernetes"), { label: "build.authenticateEnv" })
    : p
      ? await q.get(q.k.selectFrom("build_pod_runs as r").innerJoin("build_envs as e", "e.id", "r.env_id").select(["r.env_id as id", "r.key_hash"]).where("r.task_id", "=", Number(p[1])).where("e.kind", "=", "kubernetes"), { label: "build.authenticateEnv" })
      : undefined;
  const a = Buffer.from(hashOf(key), "hex");
  const b = Buffer.from(row?.key_hash ?? DUMMY_HASH, "hex");
  const same = a.length === b.length && timingSafeEqual(a, b);
  if (!row || !same) return null;
  return p ? { id: row.id, taskId: Number(p[1]) } : { id: row.id };
}

/** Creates environments with their `env-create` audit rows in one transaction; a taken id throws `StatusError` 409. Validation and key hashing are the caller's. 2 statements. */
export async function createEnv(db: Db, rows: EnvPatch[], by: string): Promise<void> {
  if (rows.length === 0) return;
  const q = queryDb(db);
  const at = new Date().toISOString();
  try {
    await db.write(async () => {
      await q.run(q.k.insertInto("build_envs").values(rows.map((r) => ({
        id: r.id, label: r.label!, kind: r.kind!, slots: r.slots!, confidential: r.confidential ? 1 : 0, confidential_since: r.confidential ? at : null, key_hash: r.keyHash!,
        created_at: at, updated_by: by, updated_at: at, settings: json(r.settings),
      }))));
      await addAudit(db, rows.map((r): NewAudit => ({ login: by, action: "env-create", target: `env:${r.id}`, at, details: { label: r.label, kind: r.kind, slots: r.slots, ...(r.confidential && { confidential: true }), ...(r.settings != null && { settings: r.settings }) } })));
    });
  } catch (e) {
    if (/UNIQUE|constraint|duplicate key/i.test((e as Error).message)) throw new StatusError(409, `environment ${rows.map((r) => r.id).join(", ")} exists`);
    throw e;
  }
}

/**
 * Updates environments (label, enabled, slots, confidential, settings; absent fields keep their value) with one `env-change` audit
 * row each that names what changed. The private tasks' clock restarts when an environment becomes confidential or is enabled while
 * confidential, and clears when it stops being confidential. A missing id throws `StatusError` 404. At most 5 statements.
 */
export async function saveEnv(db: Db, rows: EnvPatch[], by: string): Promise<void> {
  if (rows.length === 0) return;
  const q = queryDb(db);
  const at = new Date().toISOString();
  await db.write(async () => {
    const before = new Map((await q.all(q.k.selectFrom("build_envs").select(["id", "label", "enabled", "slots", "confidential", "settings"]).where(kx.inList(db, "id", rows.map((r) => r.id))))).map((b) => [b.id, b]));
    const missing = rows.find((r) => !before.has(r.id));
    if (missing) throw new StatusError(404, "no such environment");
    const next = rows.map((r) => {
      const b = before.get(r.id)!;
      const settings = r.settings !== undefined ? json(r.settings) : b.settings;
      return { id: r.id, label: r.label ?? b.label, enabled: r.enabled === undefined ? b.enabled : r.enabled ? 1 : 0, slots: r.slots ?? b.slots, confidential: r.confidential === undefined ? b.confidential : r.confidential ? 1 : 0, settings, updated_by: by, updated_at: at };
    });
    await kx.updateFrom(db, "build_envs", ["id"], next);
    const was = (id: string) => before.get(id)!;
    const clear = next.filter((n) => n.confidential !== 1).map((n) => n.id);
    const restart = next.filter((n) => n.confidential === 1 && (was(n.id).confidential !== 1 || (n.enabled === 1 && was(n.id).enabled !== 1))).map((n) => n.id);
    if (clear.length) await q.run(q.k.updateTable("build_envs").set({ confidential_since: null, confidential_online_at: null }).where(kx.inList(db, "id", clear)));
    if (restart.length) await q.run(q.k.updateTable("build_envs").set({ confidential_since: at, confidential_online_at: null }).where(kx.inList(db, "id", restart)));
    await addAudit(db, next.map((n): NewAudit => {
      const b = was(n.id);
      return {
        login: by, action: "env-change", target: `env:${n.id}`, at, details: {
          ...(n.label !== b.label && { label: n.label, was: b.label }),
          ...(n.enabled !== b.enabled && { enabled: n.enabled === 1 }),
          ...(n.slots !== b.slots && { slots: n.slots, was: b.slots }),
          ...(n.confidential !== b.confidential && { confidential: n.confidential === 1 }),
          ...(n.settings !== b.settings && { settings: n.settings === null ? null : JSON.parse(n.settings) as unknown }),
        },
      };
    }));
  });
}

/** Replaces the key hash of a worker environment (a kubernetes one has no key) with an `env-rotate-key` audit row; false when no such environment qualifies. 2 statements. */
export async function rotateEnvKey(db: Db, id: string, keyHash: string, by: string): Promise<boolean> {
  const q = queryDb(db);
  const at = new Date().toISOString();
  return await db.write(async () => {
    const r = await q.run(q.k.updateTable("build_envs").set({ key_hash: keyHash, updated_by: by, updated_at: at }).where("id", "=", id).where("kind", "!=", "kubernetes"));
    if (r.changes !== 1) return false;
    await addAudit(db, [{ login: by, action: "env-rotate-key", target: `env:${id}`, at }]);
    return true;
  });
}

const onlineAt = (eb: kx.Eb, at: string) => eb.case().when(eb.and([eb("confidential", "=", 1), eb("enabled", "=", 1), eb("confidential_online_at", "is", null)])).then(at).else(eb.ref("confidential_online_at")).end();

async function updateOne(db: Db, id: string, set: (eb: kx.Eb) => Record<string, unknown>, nowMs: number): Promise<EnvRecord> {
  const q = queryDb(db);
  const row = await q.get(q.k.updateTable("build_envs").set(set as never).where("id", "=", id).returning(ENV_COLUMNS.map((c) => c.slice(2)) as never)) as EnvDbRow | undefined;
  if (!row) throw new StatusError(404, "no such environment");
  return toEnv(row, [], nowMs);
}

/**
 * A worker's heartbeat: `last_seen_at`, and when given the capabilities, version and paused reason (`paused: null` clears it); the
 * private clock starts at the first call of an enabled confidential environment. The record has no `tasks`. 1 statement.
 */
export async function touchEnv(db: Db, id: string, r: { caps?: unknown; version?: string | null; paused?: string | null; at: string }): Promise<EnvRecord> {
  return await updateOne(db, id, (eb) => ({
    last_seen_at: r.at, confidential_online_at: onlineAt(eb, r.at),
    ...(r.caps !== undefined ? { capabilities: json(r.caps) } : {}), ...(r.version !== undefined ? { version: r.version } : {}), ...(r.paused !== undefined ? { paused_reason: r.paused } : {}),
  }), Date.parse(r.at));
}

/** The worker's first call: its capabilities, version and slots, with the pause cleared and the private clock started as in `touchEnv`. The record has no `tasks`. 1 statement. */
export async function helloEnv(db: Db, id: string, r: { caps: unknown; version: string | null; slots: number; at: string }): Promise<EnvRecord> {
  return await updateOne(db, id, (eb) => ({ capabilities: json(r.caps), reported_slots: r.slots, version: r.version, last_seen_at: r.at, paused_reason: null, confidential_online_at: onlineAt(eb, r.at) }), Date.parse(r.at));
}
