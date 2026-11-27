// The bot's replies to pings. A reply row is found by the ping's or the quoted message's keyed hash; deleting a reply
// deletes the Discord message first and the row after, so a failed delete leaves the row for a later request.
import type { DiscordKeys } from "./keys.ts";
import type { DiscordRest } from "./rest.ts";
import type { Db } from "../db/index.ts";
import * as dc from "../data/discord/index.ts";

/** Deletes the replies whose ping or quoted message is one of `ids`. Returns how many rows were removed. */
export async function deleteRepliesOf(db: Db, keys: DiscordKeys, rest: DiscordRest, ids: string[], log: (line: string) => void): Promise<number> {
  const rows = await dc.loadRepliesOf(db, ids.map((id) => keys.hash("message", id)));
  const done: string[] = [];
  for (const r of new Map(rows.map((x) => [x.pingHash, x])).values()) {
    const ref = keys.open(r.sealed, r.pingHash);
    try {
      if (ref) await rest.deleteMessage(ref.channelId, ref.messageId);
    } catch (e) {
      log(`discord: deleting a reply failed: ${(e as Error).message}`);
      continue;
    }
    done.push(r.pingHash);
  }
  return await dc.removeReplies(db, done);
}
