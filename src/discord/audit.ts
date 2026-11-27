import { addAudit } from "../data/control/index.ts";
import type { Db } from "../db/index.ts";

/** One audit row; inside a `db.write` it commits with the change it records. */
export const audit = async (db: Db, login: string, action: string, target: string | null, details?: unknown): Promise<void> =>
  await addAudit(db, [{ login, action, target, ...(details !== undefined && { details }) }]);
