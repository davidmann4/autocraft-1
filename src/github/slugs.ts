// The GitHub App slugs ever seen, kept in settings so the bot stays ours after the app is replaced or its secrets cannot be read.
import { setting, writeSetting } from "../data/control/index.ts";
import type { Db } from "../db/index.ts";

export const SLUGS_KEY = "app_slugs";
/** The instance setting for the name people type to address the app (no `@`); unset or empty means the app slug. */
export const MENTION_KEY = "github_mention_name";

/** GitHub's login rules: letters, digits and single hyphens, not starting or ending with one, at most 39 characters. */
export const validMentionName = (v: string): boolean => v.length <= 39 && /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*$/.test(v);

/** The configured mention name, or null when unset. */
export async function mentionName(db: Db): Promise<string | null> {
  const v = (await setting(db, MENTION_KEY))?.trim();
  return v && validMentionName(v) ? v : null;
}

/** What a comment can address the app by: its slug and the mention name (when set), without duplicates. */
export const addressNames = (slug: string | null | undefined, mention: string | null | undefined): string[] =>
  [...new Set([slug, mention].filter((x): x is string => !!x))];

/** The name to tell people to type: the mention name when set, otherwise the slug. */
export const shownMention = (slug: string | null | undefined, mention: string | null | undefined): string | null => mention || slug || null;

/** The names a comment to the app can start with, read from the settings. */
export async function commentNames(db: Db, slug: string | null | undefined): Promise<string[]> {
  return addressNames(slug, await mentionName(db));
}

export const parseSlugs = (v: string | undefined): string[] => {
  try {
    const a = JSON.parse(v ?? "[]") as unknown;
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
};

/** Every app slug ever seen (a slug can only be ours), oldest first. */
export const knownSlugs = async (db: Db): Promise<string[]> => parseSlugs(await setting(db, SLUGS_KEY));

/** Records `slug` in the persisted list when it is new. */
export async function rememberSlug(db: Db, slug: string): Promise<void> {
  const recorded = remembered.get(db) ?? new Set<string>();
  // A recorded slug stays recorded, so this process asks the table once.
  if (recorded.has(slug)) return;
  // Read from the table, not a pass snapshot: another connection may have recorded a slug since the pass began.
  const known = parseSlugs((await setting(db, SLUGS_KEY)) ?? undefined);
  if (!known.includes(slug)) await writeSetting(db, SLUGS_KEY, JSON.stringify([...known, slug]));
  remembered.set(db, recorded.add(slug));
}
const remembered = new WeakMap<Db, Set<string>>();

/** The names a comment can address the pipeline by: the pipeline login (when recorded) every known app slug and the mention name. Mentioning `@<slug>` also covers `@<slug>[bot]`. */
export async function mentionNames(db: Db, extra: string | null = null): Promise<string[]> {
  const [box, slugs, mention] = await db.together(() => Promise.all([setting(db, "pipeline_login"), knownSlugs(db), mentionName(db)]));
  return namesOf(box, slugs, extra, mention);
}

/** mentionNames() from the stored pipeline login and the known slugs. */
export const namesOf = (box: string | undefined, slugs: string[], extra: string | null = null, mention: string | null = null): string[] =>
  [...new Set([...(box ? [box] : []), ...slugs, ...(extra ? [extra] : []), ...(mention ? [mention] : [])])];
