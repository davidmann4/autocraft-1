// The accepted models per tier (src/remote/mode.ts) and the Jev switch. Operators only; changes are audited.
import type { JevStatus } from "../../../web/src/api/types.ts";
import { jevEnabled, jevOutage, setJevEnabled } from "../../agents/jev.ts";
import { acceptedModels, minEfforts, setAcceptedModels } from "../../remote/mode.ts";
import type { Effort, Tier } from "../../remote/protocol.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import type { Db } from "../../db/index.ts";

export type InferenceSettings = { models: Record<Tier, string[]>; minEffort: Partial<Record<Tier, Effort>> };

export const get = async (db: Db): Promise<InferenceSettings> => ({ models: await acceptedModels(db), minEffort: await minEfforts(db) });

/** Body `{models?, minEffort?}`; `minEffort` maps a tier to its lowest effort, or null for none. */
export async function put(db: Db, req: Req): Promise<InferenceSettings> {
  if (req.user.role !== "operator") throw new HttpError(403, "only operators change the accepted models");
  const b = req.json;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "the body must be a JSON object");
  const { models, minEffort } = b as { models?: unknown; minEffort?: unknown };
  if (models !== undefined || minEffort !== undefined) {
    try { await setAcceptedModels(db, models, req.user.login, minEffort); } catch (e) { throw new HttpError(400, (e as Error).message); }
  }
  return await get(db);
}

export async function getJev(db: Db): Promise<JevStatus> {
  const o = await jevOutage(db);
  return { enabled: await jevEnabled(db), unavailable: o ? { reason: o.reason, since: o.since } : null };
}

/** Body `{enabled}`. */
export async function putJev(db: Db, req: Req): Promise<JevStatus> {
  const enabled = (req.json as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
  await setJevEnabled(db, enabled, req.user.login);
  return await getJev(db);
}
