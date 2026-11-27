// What a Discord channel may show of an item's work. A channel is public to its server, so the work on an item of a private repo, or
// one kept quiet as a possible security problem (src/security), shows only as status lines and links, never review text or code.
import { loadQuiet } from "../data/security/index.ts";
import type { Db } from "../db/index.ts";
import { publicRepoNames } from "../public/status.ts";
import type { ItemRef } from "../workflow/types.ts";

/** `full`: results may be posted as they are on GitHub; `status`: only status lines and links. */
export type DiscordDetail = "full" | "status";

/** The detail each item may show, by `repo#number` (the repo's short name). */
export async function discordDetail(db: Db, items: readonly ItemRef[]): Promise<Map<string, DiscordDetail>> {
  const keyOf = (i: ItemRef): string => `${i.repo.split("/").pop()!}#${i.number}`;
  const [pub, quiet] = await Promise.all([publicRepoNames(db), loadQuiet(db, items.map(keyOf))]);
  const open = new Set(pub);
  return new Map(items.map((i) => [keyOf(i), open.has(i.repo.split("/").pop()!) && !quiet.has(keyOf(i)) ? "full" : "status"]));
}
