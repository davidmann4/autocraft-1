// The readiness of the user-local helpers (Task Runners): each sends its status (POST ROUTES.status) on every change and at
// least every STATUS_EVERY_S while it runs; the last one is kept per runner credential, with its slots and busy count. The
// planner's room counts only runners whose last status is `ready` and fresh, by their free slots (room.ts); the Connect
// page (GET /api/runners) and my_work list the user's own.
import { HttpError } from "../dash/server/util.ts";
import { isTier } from "./mode.ts";
import { READINESS, type HarnessId, type HelperInfo, type HelperStatus, type Machine, type Readiness, type Tier, type UsageReading, type UsageWindow } from "./protocol.ts";
import type { Db } from "../db/index.ts";
import * as runners from "../data/runners/index.ts";

/** A status this old no longer counts: one report interval and a minute of slack. */
export const STATUS_FRESH_MS = runners.STATUS_FRESH_MS;

const HARNESSES: HarnessId[] = ["claude", "codex"];
const REASON_MAX = 300;

const isoTime = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
const percent = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;

function parseWindow(v: unknown, name: string): UsageWindow | null {
  if (v === null || v === undefined) return null;
  const w = v as Record<string, unknown>;
  if (typeof v !== "object" || !percent(w.usedPercent) || !(w.resetsAt === null || isoTime(w.resetsAt))) throw new HttpError(400, `usage.${name} must be { usedPercent: 0-100, resetsAt: ISO time or null }`);
  return { usedPercent: w.usedPercent, resetsAt: w.resetsAt as string | null };
}

/** The status body, checked; throws HttpError 400 for a malformed one. */
export function parseStatus(raw: unknown): HelperStatus {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "the body must be a HelperStatus object");
  const s = raw as Record<string, unknown>;
  if (!READINESS.includes(s.readiness as Readiness)) throw new HttpError(400, `readiness must be one of ${READINESS.join(", ")}`);
  if (s.until !== undefined && s.until !== null && !isoTime(s.until)) throw new HttpError(400, "until must be an ISO time");
  if (s.reason !== undefined && typeof s.reason !== "string") throw new HttpError(400, "reason must be a string");
  if (!HARNESSES.includes(s.harness as HarnessId)) throw new HttpError(400, `harness must be one of ${HARNESSES.join(", ")}`);
  const models: Partial<Record<Tier, string>> = {};
  if (!s.models || typeof s.models !== "object" || Array.isArray(s.models)) throw new HttpError(400, "models must map a tier to a model");
  for (const [t, m] of Object.entries(s.models as Record<string, unknown>)) {
    if (!isTier(t) || typeof m !== "string" || !m || m.length > 100) throw new HttpError(400, `models.${t}: a known tier with a model name`);
    models[t] = m;
  }
  const r = s.reserve as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object" || !percent(r.fiveHour) || !percent(r.weekly)) throw new HttpError(400, "reserve must be { fiveHour, weekly }, each 0-100");
  let usage: UsageReading | undefined;
  if (s.usage !== undefined && s.usage !== null) {
    const u = s.usage as Record<string, unknown>;
    if (typeof u !== "object" || !isoTime(u.at)) throw new HttpError(400, "usage must be { fiveHour, weekly, at }");
    usage = { fiveHour: parseWindow(u.fiveHour, "fiveHour"), weekly: parseWindow(u.weekly, "weekly"), at: u.at };
  }
  const reason = typeof s.reason === "string" ? s.reason.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, REASON_MAX) : "";
  const count = (v: unknown, name: string): number => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 64) throw new HttpError(400, `${name} must be a whole number from 0 to 64`);
    return v;
  };
  const slots = count(s.slots, "slots"), busy = count(s.busy, "busy");
  let lastError: HelperStatus["lastError"];
  if (s.lastError !== undefined && s.lastError !== null) {
    const e = s.lastError as Record<string, unknown>;
    if (typeof e !== "object" || typeof e.text !== "string" || !isoTime(e.at)) throw new HttpError(400, "lastError must be { text, at }");
    lastError = { text: e.text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, REASON_MAX), at: e.at };
  }
  if (s.helperVersion !== undefined && (typeof s.helperVersion !== "string" || !/^[0-9A-Za-z.+-]{1,40}$/.test(s.helperVersion))) throw new HttpError(400, "helperVersion must be a version string");
  let machine: Machine | undefined;
  if (s.machine !== undefined) {
    const m = s.machine as Record<string, unknown>;
    const field = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
    if (!m || typeof m !== "object" || !field(m.hostname, 253) || !field(m.platform, 40) || !field(m.arch, 40)) throw new HttpError(400, "machine must be { hostname, platform, arch }");
    machine = { hostname: m.hostname, platform: m.platform, arch: m.arch };
  }
  return {
    slots, busy: Math.min(busy, slots), ...(lastError && { lastError }), ...(typeof s.helperVersion === "string" && { helperVersion: s.helperVersion }), ...(machine && { machine }),
    readiness: s.readiness as Readiness, ...(isoTime(s.until) && { until: s.until }), ...(reason && { reason }),
    harness: s.harness as HarnessId, models, reserve: { fiveHour: r.fiveHour as number, weekly: r.weekly as number }, ...(usage && { usage }),
  };
}

/** Keeps a helper's status as the last one of its credential, with the machine it names. Rows of deleted credentials go with the dashboard's minute maintenance (pruneRemote). */
export async function storeStatus(db: Db, tokenId: number, login: string, s: HelperStatus, nowMs: number = Date.now()): Promise<void> {
  await runners.saveHelperStatus(db, tokenId, login, s, nowMs);
}

/** Whether the login has a Task Runner whose last status is fresh (the MCP Connector then offers the task tools). */
export async function hasFreshRunner(db: Db, login: string, nowMs: number = Date.now()): Promise<boolean> {
  return (await runners.hasFreshRunners(db, [login], nowMs)).has(login.toLowerCase());
}

/** The login's helpers: every live Task Runner credential, with its last status. */
export async function listHelpers(db: Db, login: string, nowMs: number = Date.now()): Promise<HelperInfo[]> {
  const helpers = await runners.loadHelpers(db, [login], nowMs);
  return (helpers.get(login.toLowerCase()) ?? []).map((h) => {
    // The server's own cool-off of the login shows even before the helper has reported it.
    const cooled = h.cooledUntil !== null;
    return {
      tokenId: h.tokenId, label: h.label, slots: h.slots, busy: h.busy, lastError: h.lastError,
      ...(cooled ? { readiness: "cooled-off" as const, until: h.cooledUntil, reason: h.cooledReason } : { readiness: h.readiness, until: h.until, reason: h.reason }),
      fresh: h.fresh, lastSeen: h.lastSeen, harness: h.harness as HarnessId | null, models: h.models, reserve: h.reserve, usage: h.usage as UsageReading | null,
    };
  });
}
