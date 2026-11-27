import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";

/** True when the database answers a trivial query. */
export async function pingDb(db: Db): Promise<boolean> {
  try {
    const q = queryDb(db);
    await q.get(q.k.selectNoFrom((eb) => eb.lit(1).as("one")));
    return true;
  } catch {
    return false;
  }
}
