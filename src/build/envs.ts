// Build environments (workers): operator-registered places that run untrusted
// code. The coordinator holds only a hash of each worker key. Everything a
// worker reports is stored as data and shown as text.
import { createHash, randomBytes } from "node:crypto";
import type { BuildEnv, Capabilities, EnvKind } from "../../web/src/api/types.ts";
import { parseSettings, settingsOf } from "./pods.ts";
import type { Db } from "../db/index.ts";
import { authenticateEnv, createEnv as saveNewEnv, helloEnv, loadEnvs, loadEnvTasks, reportKubeEnv, rotateEnvKey, saveEnv, StatusError, touchEnv } from "../data/build/index.ts";
import type { EnvRecord } from "../data/build/index.ts";

export class BuildError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Maps the data module's refusals to the status errors the API answers with. */
export const rethrow = (e: unknown): never => {
  throw e instanceof StatusError ? new BuildError(e.status, e.message) : e;
};

export { ONLINE_MS } from "../data/build/index.ts";
export const MAX_SLOTS = 200;
export const LABEL_MAX = 40;
export const ENV_ID_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
export const KINDS: EnvKind[] = ["local-sandbox", "remote", "kubernetes"];
const KEY_PREFIX = "cwk";
const POD_KEY_PREFIX = "cwp";

export const hashKey = (key: string): string => createHash("sha256").update(key).digest("hex");

/** A new key: `cwk_<env id>_<secret>`; the id lets the coordinator find the row without scanning. */
export function newKey(envId: string): string {
  return `${KEY_PREFIX}_${envId}_${randomBytes(32).toString("base64url")}`;
}

/** A build pod's one-time key, `cwp_<task id>_<secret>`: valid while the task's pod run exists (launcher.ts). */
export function newPodKey(taskId: number): string {
  return `${POD_KEY_PREFIX}_${taskId}_${randomBytes(32).toString("base64url")}`;
}

/** The key hash of a kubernetes environment: not a SHA-256 hex digest, so no key matches it. */
const UNUSABLE_HASH = "none";

/**
 * The environment a bearer key belongs to, or null; a pod key also names its one task. The comparison takes the same time
 * for a wrong key and an unknown id.
 */
export const authenticate = async (db: Db, key: string): Promise<{ id: string; taskId?: number } | null> => await authenticateEnv(db, key);

export const slotsOf = (r: { slots: number; reported_slots: number | null }): number => Math.min(r.slots, r.reported_slots ?? r.slots);

/** The kubernetes settings of an environment record, with the defaults filled in. */
export const envSettings = (r: Pick<EnvRecord, "settings">): ReturnType<typeof settingsOf> => settingsOf(r.settings === null || r.settings === undefined ? null : JSON.stringify(r.settings));

const toEnv = (r: EnvRecord): BuildEnv => ({
  id: r.id, label: r.label, kind: r.kind, enabled: r.enabled, online: r.online, lastSeenAt: r.lastSeenAt, slots: r.slots, running: r.running, tasks: r.tasks,
  capabilities: r.capabilities, version: r.version, pausedReason: r.pausedReason, confidential: r.confidential,
  settings: r.kind === "kubernetes" ? envSettings(r) : null,
});

/** Every environment, in the order they were registered. */
export async function listEnvs(db: Db, nowMs: number = Date.now()): Promise<BuildEnv[]> {
  return (await loadEnvs(db, { nowMs })).map(toEnv);
}

export async function getEnv(db: Db, id: string, nowMs: number = Date.now()): Promise<BuildEnv | null> {
  const r = (await loadEnvs(db, { ids: [id], nowMs }))[0];
  return r ? toEnv(r) : null;
}

function checkLabel(v: unknown): string {
  if (typeof v !== "string") throw new BuildError(400, "label must be text");
  const l = v.trim();
  if (!l || l.length > LABEL_MAX || /[\u0000-\u001f<>@]/.test(l)) throw new BuildError(400, `label must be 1 to ${LABEL_MAX} characters without @, < or >`);
  return l;
}

function checkSlots(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_SLOTS) throw new BuildError(400, `slots must be a whole number from 1 to ${MAX_SLOTS}`);
  return v;
}

function checkFlag(v: unknown, name: string): boolean {
  if (typeof v !== "boolean") throw new BuildError(400, `${name} must be true or false`);
  return v;
}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new BuildError(400, "the body must be a JSON object");
  return input as Record<string, unknown>;
}

/**
 * Registers an environment. The key is returned here and never again. A kubernetes environment has no worker and no key:
 * the runner starts its pods, each task's with a one-time key.
 */
export async function createEnv(db: Db, input: unknown, by: string): Promise<{ env: BuildEnv; key: string | null }> {
  const o = object(input);
  const bad = Object.keys(o).find((k) => !["id", "label", "kind", "slots", "confidential", "settings"].includes(k));
  if (bad) throw new BuildError(400, `${bad} cannot be set`);
  const id = o.id;
  if (typeof id !== "string" || !ENV_ID_RE.test(id)) throw new BuildError(400, "id must be 3 to 32 lowercase letters, digits or hyphens, starting with a letter");
  const label = checkLabel(o.label);
  if (!KINDS.includes(o.kind as EnvKind)) throw new BuildError(400, `kind must be ${KINDS.join(" or ")}`);
  const slots = checkSlots(o.slots);
  const confidential = o.confidential === undefined ? false : checkFlag(o.confidential, "confidential");
  const kube = o.kind === "kubernetes";
  if (!kube && o.settings !== undefined) throw new BuildError(400, "settings are only for kubernetes environments");
  const key = newKey(id);
  await saveNewEnv(db, [{ id, label, kind: o.kind as EnvKind, slots, confidential, keyHash: kube ? UNUSABLE_HASH : hashKey(key), settings: kube ? parseSettings(o.settings) : undefined }], by)
    .catch(rethrow);
  return { env: (await getEnv(db, id))!, key: kube ? null : key };
}

export async function updateEnv(db: Db, id: unknown, input: unknown, by: string): Promise<BuildEnv> {
  const o = object(input);
  const bad = Object.keys(o).find((k) => !["label", "enabled", "slots", "confidential", "settings"].includes(k));
  if (bad) throw new BuildError(400, `${bad} cannot be set`);
  const before = typeof id === "string" ? (await loadEnvs(db, { ids: [id] }))[0] : undefined;
  if (!before) throw new BuildError(404, "no such environment");
  if (o.settings !== undefined && before.kind !== "kubernetes") throw new BuildError(400, "settings are only for kubernetes environments");
  const beforeSettings = before.settings === null ? null : JSON.stringify(before.settings);
  const settings = o.settings !== undefined ? parseSettings(o.settings, settingsOf(beforeSettings)) : undefined;
  if (settings && settings.namespace !== settingsOf(beforeSettings).namespace && (await loadEnvTasks(db, before.id)).runs.length) {
    throw new BuildError(409, "the namespace cannot change while tasks run in it; disable the environment and wait for them to finish");
  }
  await saveEnv(db, [{
    id: before.id,
    ...(o.label !== undefined ? { label: checkLabel(o.label) } : {}),
    ...(o.enabled !== undefined ? { enabled: checkFlag(o.enabled, "enabled") } : {}),
    ...(o.slots !== undefined ? { slots: checkSlots(o.slots) } : {}),
    ...(o.confidential !== undefined ? { confidential: checkFlag(o.confidential, "confidential") } : {}),
    ...(settings ? { settings } : {}),
  }], by).catch(rethrow);
  return (await getEnv(db, before.id))!;
}

/** A new key; the old one stops working at once. */
export async function rotateKey(db: Db, id: unknown, by: string): Promise<{ key: string }> {
  const row = typeof id === "string" ? (await loadEnvs(db, { ids: [id] }))[0] : undefined;
  if (!row) throw new BuildError(404, "no such environment");
  if (row.kind === "kubernetes") throw new BuildError(400, "a kubernetes environment has no key: each task's pods get a one-time key");
  const key = newKey(id as string);
  if (!await rotateEnvKey(db, id as string, hashKey(key), by)) throw new BuildError(404, "no such environment");
  return { key };
}

const OS = ["linux", "macos", "windows"], ARCH = ["x86_64", "aarch64"];
const TOOLCHAIN_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;

/** Checks what a worker reports about itself; anything else is refused. */
export function parseCapabilities(v: unknown): Capabilities {
  const o = object(v);
  const int = (k: string, max: number) => {
    const n = o[k];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > max) throw new BuildError(400, `capabilities.${k} must be a number from 0 to ${max}`);
    return Math.round(n);
  };
  if (!OS.includes(o.os as string)) throw new BuildError(400, "capabilities.os is not known");
  if (!ARCH.includes(o.arch as string)) throw new BuildError(400, "capabilities.arch is not known");
  if (typeof o.display !== "boolean" || typeof o.gpu !== "boolean") throw new BuildError(400, "capabilities.display and gpu must be true or false");
  const tc = o.toolchains;
  if (!Array.isArray(tc) || tc.length > 40 || tc.some((t) => typeof t !== "string" || !TOOLCHAIN_RE.test(t))) throw new BuildError(400, "capabilities.toolchains must be a list of at most 40 short names");
  return {
    os: o.os as Capabilities["os"], arch: o.arch as Capabilities["arch"], cpus: int("cpus", 4096), memGb: int("memGb", 65536), diskGb: int("diskGb", 10_000_000),
    display: o.display, gpu: o.gpu, toolchains: [...new Set(tc as string[])].sort(),
    ...(o.warmSigner === true ? { warmSigner: true } : {}),
  };
}

/** Records a call from the worker: the heartbeat and, when given, its paused reason. */
export async function touch(db: Db, id: string, paused?: string | null): Promise<void> {
  await touchEnv(db, id, { at: new Date().toISOString(), ...(paused === undefined ? {} : { paused }) });
}

/** The worker's first call: stores what it can do, capped by the operator's slot count. */
export async function hello(db: Db, id: string, body: unknown): Promise<{ envId: string; label: string; slots: number }> {
  const o = object(body);
  const caps = parseCapabilities(o.capabilities);
  const version = typeof o.version === "string" && o.version.length <= 40 && /^[\w.+-]+$/.test(o.version) ? o.version : null;
  if (typeof o.slots !== "number" || !Number.isInteger(o.slots) || o.slots < 0 || o.slots > 1024) throw new BuildError(400, "slots must be a whole number");
  const r = await helloEnv(db, id, { caps, version, slots: o.slots, at: new Date().toISOString() });
  return { envId: id, label: r.label, slots: r.slots };
}

export type EnvHealth = { state: "warn" | "fail"; text: string; since: string };

/**
 * The pod launcher's pass over a kubernetes environment: what its pods offer, its health (undefined keeps it), and, when
 * the Kubernetes API answered, the heartbeat. `health` keeps its `since` while the text stays the same; `slots` undefined keeps the reported slots.
 */
export async function kubeReport(db: Db, id: string, caps: Capabilities, slots: number | undefined, health: Omit<EnvHealth, "since"> | null | undefined, reachable: boolean): Promise<void> {
  const priorHealth = health ? (await loadEnvs(db, { ids: [id] }))[0]?.health ?? null : null;
  await reportKubeEnv(db, { id, caps, slots, health, priorHealth, reachable, at: new Date().toISOString() });
}
