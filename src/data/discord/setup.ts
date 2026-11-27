// The Discord admin page's read model.
import type { Db } from "../../db/index.ts";
import { countEvents } from "./events.ts";
import { listChannelRows, loadStatus } from "./channels.ts";
import { listFilingRepos, listHiddenRepos, listRecentFiled } from "./filing.ts";
import type { DiscordSetupData } from "./types.ts";

/** The most recent filed issues the page shows. */
const RECENT_FILED = 20;

/** Status, channels, filing, hidden, recent filed and event counts: 6 statements in 1 round trip; the page composes the rest in the same wave. */
export async function loadDiscordSetup(db: Db, o: { nowMs: number }): Promise<DiscordSetupData> {
  const [status, channels, filing, hidden, recentFiled, eventCounts] = await db.together(() => Promise.all([
    loadStatus(db), listChannelRows(db), listFilingRepos(db), listHiddenRepos(db), listRecentFiled(db, RECENT_FILED), countEvents(db, o.nowMs),
  ]));
  return { status, channels, filing, hidden, recentFiled, eventCounts };
}
