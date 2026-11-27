// The model tiers and the model families each tier accepts. Claude model calls are queued as remote calls that Task Runners
// claim, run on their own machines and submit (src/remote/calls.ts). Jev calls and embeddings run on this host.
import { EFFORTS, type Effort, type HarnessId, type Tier } from "./protocol.ts";
import type { Db } from "../db/index.ts";
import { saveSettings, setting } from "../data/control/index.ts";

/** The tier a model name of the prompt registry belongs to. */
export function tierOfModel(model: string): Tier {
  if (/opus/i.test(model)) return "top";
  if (/sonnet/i.test(model)) return "mid";
  if (/haiku/i.test(model)) return "small";
  throw new Error(`no tier for model ${model}`);
}

export const TIERS: readonly Tier[] = ["top", "mid", "small"];
export const isTier = (v: unknown): v is Tier => typeof v === "string" && (TIERS as readonly string[]).includes(v);

export const REMOTE_MODELS_KEY = "remote_models";
/** Codex's top model family: matches the Astra ids of Codex's bundled model catalogue (gpt-6.2-astra, gpt-6-astra); operators change it in the setting. */
export const CODEX_TOP_PLACEHOLDER = "astra";
/** The model families each tier accepts unless the `remote_models` setting says otherwise. */
export const DEFAULT_REMOTE_MODELS: Record<Tier, string[]> = { top: ["opus", CODEX_TOP_PLACEHOLDER], mid: ["sonnet"], small: ["haiku"] };
const FAMILY = /^[a-z0-9][a-z0-9.-]{0,39}$/;

const parsedModels = (raw: string | undefined): Record<string, unknown> => {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch { return {}; }
};

const rawModels = async (db: Db): Promise<Record<string, unknown>> => parsedModels(await setting(db, REMOTE_MODELS_KEY));

const acceptedOf = (raw: Record<string, unknown>): Record<Tier, string[]> => {
  const { minEffort: _, ...fams } = raw;
  try { return { ...DEFAULT_REMOTE_MODELS, ...checkModels(fams) }; } catch { return DEFAULT_REMOTE_MODELS; }
};
const floorsOf = (raw: Record<string, unknown>): Partial<Record<Tier, Effort>> => {
  try { return checkEfforts(raw.minEffort ?? {}); } catch { return {}; }
};

export async function acceptedModels(db: Db): Promise<Record<Tier, string[]>> {
  return acceptedOf(await rawModels(db));
}

/** The accepted models and effort floors (acceptedModels, minEfforts) of a stored `remote_models` value (undefined: no row). */
export function modelsOf(value: string | undefined): { accepted: Record<Tier, string[]>; floors: Partial<Record<Tier, Effort>> } {
  const raw = parsedModels(value);
  return { accepted: acceptedOf(raw), floors: floorsOf(raw) };
}

export const isEffort = (v: unknown): v is Effort => typeof v === "string" && (EFFORTS as readonly string[]).includes(v);

/** The lowest effort each tier accepts, for the tiers that set one (stored as `minEffort` beside the families in the `remote_models` setting). */
export async function minEfforts(db: Db): Promise<Partial<Record<Tier, Effort>>> {
  return floorsOf(await rawModels(db));
}

/** `{tier: effort}` for some or all tiers, checked; throws with the reason. */
function checkEfforts(v: unknown): Partial<Record<Tier, Effort>> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("minEffort must map a tier to an effort");
  const out: Partial<Record<Tier, Effort>> = {};
  for (const [t, e] of Object.entries(v as Record<string, unknown>)) {
    if (!isTier(t)) throw new Error(`unknown tier ${t}`);
    if (!isEffort(e)) throw new Error(`tier ${t}: effort must be one of ${EFFORTS.join(", ")}`);
    out[t] = e;
  }
  return out;
}

/**
 * Whether `declared` meets `floor` on the ladder. Codex stops at xhigh, so there xhigh meets a max floor. No floor is always met;
 * a floor with no declared effort (an older helper) is not.
 */
export function meetsEffort(declared: Effort | undefined, floor: Effort | undefined, harness: HarnessId): boolean {
  if (!floor) return true;
  if (!declared) return false;
  const top = harness === "codex" ? EFFORTS.indexOf("xhigh") : EFFORTS.length;
  return Math.min(EFFORTS.indexOf(declared), top) >= Math.min(EFFORTS.indexOf(floor), top);
}

/** `{tier: [family, ...]}` for some or all tiers, checked; throws with the reason. */
function checkModels(v: unknown): Partial<Record<Tier, string[]>> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("models must map a tier to a list of model families");
  const out: Partial<Record<Tier, string[]>> = {};
  for (const [t, list] of Object.entries(v as Record<string, unknown>)) {
    if (!isTier(t)) throw new Error(`unknown tier ${t}`);
    if (!Array.isArray(list) || !list.length || list.length > 10 || !list.every((f) => typeof f === "string" && FAMILY.test(f))) throw new Error(`tier ${t}: 1 to 10 lowercase model families, such as opus`);
    out[t] = [...new Set(list as string[])];
  }
  return out;
}

/**
 * Replaces the accepted families and minimum efforts of the tiers given (audited as `by`). `minEffort` maps a tier to an
 * effort, or to null to remove its floor. Returns the families table.
 */
export async function setAcceptedModels(db: Db, raw: unknown, by: string, minEffort?: unknown): Promise<Record<Tier, string[]>> {
  const next = raw === undefined ? await acceptedModels(db) : { ...await acceptedModels(db), ...checkModels(raw) };
  let floors = await minEfforts(db);
  if (minEffort !== undefined) {
    if (!minEffort || typeof minEffort !== "object" || Array.isArray(minEffort)) throw new Error("minEffort must map a tier to an effort");
    const set: Record<string, unknown> = {}, clear: string[] = [];
    for (const [t, e] of Object.entries(minEffort as Record<string, unknown>)) {
      if (e === null) clear.push(t);
      else set[t] = e;
    }
    floors = { ...floors, ...checkEfforts(set) };
    for (const t of clear) { if (!isTier(t)) throw new Error(`unknown tier ${t}`); delete floors[t]; }
  }
  const stored = { ...next, ...(Object.keys(floors).length && { minEffort: floors }) };
  await saveSettings(db, [{ key: REMOTE_MODELS_KEY, value: JSON.stringify(stored) }], by, { action: "remote-models", target: REMOTE_MODELS_KEY, details: stored });
  return next;
}

/** The family of `families` that a model alias or id belongs to (claude-opus-4-5 and opus are both opus), or null. */
export function familyOf(model: string, families: readonly string[]): string | null {
  const m = model.toLowerCase();
  return families.find((f) => new RegExp(`(^|[^a-z0-9])${f.replace(/[.-]/g, "\\$&")}([^a-z0-9]|$)`).test(m)) ?? null;
}
