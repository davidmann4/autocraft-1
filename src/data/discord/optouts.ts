// Discord users who opted out of message tracking (`discord_optouts`): keyed hashes of their user ids.
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";

/** Whether the user hash is opted out. */
export async function isOptedOut(db: Db, userHash: string): Promise<boolean> {
  const q = queryDb(db);
  return !!await q.get(q.k.selectFrom("main.discord_optouts").select("user_hash").where("user_hash", "=", userHash), { label: "discord.isOptedOut" });
}

/** Opts the user hash out (`out`) or back in. Returns whether that changed anything. */
export async function setOptedOut(db: Db, userHash: string, out: boolean, at: string): Promise<boolean> {
  const q = queryDb(db);
  const r = out
    ? await q.run(q.k.insertInto("main.discord_optouts").values({ user_hash: userHash, opted_out_at: at }).onConflict((oc) => oc.column("user_hash").doNothing()))
    : await q.run(q.k.deleteFrom("main.discord_optouts").where("user_hash", "=", userHash));
  return Number(r.changes) > 0;
}
