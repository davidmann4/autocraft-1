// What the bot says about search results: a section per match with its GitHub link button beside it, and a "File a new issue"
// button. Shared by ping replies and the commands.
import type { Match } from "./search.ts";
import { publicRepoNames } from "../public/status.ts";
import { formButtonId } from "./issue-draft.ts";
import { trackedRepos } from "./store.ts";
import type { Db } from "../db/index.ts";
import { loadChannelDefaults } from "../data/discord/index.ts";

const TITLE_CHARS = 80;
/** Discord refuses message content over 2,000 characters; matches that don't fit are left out with their buttons. */
const CONTENT_CHARS = 1900;

const oneLine = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Titles and reasons are plain text in the line: markdown characters are replaced so a title cannot format or link. */
export const plain = (s: string): string => s.replace(/[[\]()<>*_`~|\\#:@]/g, " ").replace(/\s+/g, " ").trim();

/** The repo whose new-issue page the button opens: the channel's setting (a thread uses its parent's), else the top result's, else the only public tracked repo. Never a private repo. */
export async function fileRepoUrl(db: Db, channelId: string | undefined, matches: Match[]): Promise<string | null> {
  const set = channelId === undefined ? undefined : (await loadChannelDefaults(db, [channelId])).get(channelId)?.defaultRepo;
  const names = new Set(await publicRepoNames(db));
  const tracked = (await trackedRepos(db)).filter((t) => names.has(t.name));
  const name = (set && names.has(set) ? set : null) ?? (matches[0] && names.has(matches[0].repo) ? matches[0].repo : null) ?? (tracked.length === 1 ? tracked[0]!.name : null);
  const t = tracked.find((x) => x.name === name);
  return t ? `https://github.com/${t.owner}/${t.name}` : null;
}

/** Components V2 replaces `content`: a message with this flag is built from components only. */
export const IS_COMPONENTS_V2 = 1 << 15;
/** Discord allows 40 components per V2 message; a result takes three (section, text, button) and the action row two or more. */
const MAX_RESULTS = 10;

export type Body = { content?: string; components: unknown[]; flags?: number };
/** `legacy` is the numbered layout used when Discord rejects the V2 message. */
export type Rendered = { components: unknown[]; flags: number; legacy: Body };
/** Discord allows five buttons per action row. */
const ROW_BUTTONS = 5;
let loggedRejection = false;

/** Sends the V2 body; when Discord answers 4xx, sends the numbered legacy body once instead and logs the first rejection. */
export async function deliver(r: Rendered, send: (body: Body) => Promise<unknown>, log: (line: string) => void = console.warn): Promise<void> {
  try {
    await send({ components: r.components, flags: r.flags });
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === undefined || status < 400 || status >= 500) throw e;
    if (!loggedRejection) { loggedRejection = true; log(`discord: components v2 reply rejected (${status}): ${(e as Error).message.slice(0, 200)}`); }
    await send(r.legacy);
  }
}

const sectionText = (m: Match): string => `${m.repo}#${m.number} ${oneLine(plain(m.title), TITLE_CHARS)}${m.pr ? " (PR)" : ""}${m.merged ? " (merged)" : m.closed ? " (closed)" : ""}`;

/** Each result is a section: its text with its link button beside it, so a button is never far from the issue it opens. "File a new issue" and the other actions sit in a row at the end. */
export async function renderMatches(db: Db, matches: Match[], question: string, channelId: string | undefined, noneId?: string): Promise<Rendered> {
  const sections: unknown[] = [];
  const shown: Match[] = [];
  let size = 0;
  for (const m of matches.slice(0, MAX_RESULTS)) {
    const text = sectionText(m);
    if (size + text.length + 1 > CONTENT_CHARS) break;
    size += text.length + 1;
    sections.push({
      type: 9,
      components: [{ type: 10, content: text }],
      accessory: { type: 2, style: 5, label: `${m.repo}#${m.number}`.slice(0, 80), url: m.url },
    });
    shown.push(m);
  }
  if (!sections.length) sections.push({ type: 10, content: "No matching issue found." });
  const buttons: unknown[] = [];
  const repo = await fileRepoUrl(db, channelId, shown);
  // `noneId` is the button of the search form's reply: it continues that session instead of opening the form again.
  if (noneId) buttons.push({ type: 2, style: 2, label: "None of these, file a new one", custom_id: noneId });
  else if (repo) buttons.push({ type: 2, style: 2, label: "File a new issue", custom_id: formButtonId(repo.split("/").pop()!, question) });
  const lines = shown.map((m, i) => `${i + 1}. ${sectionText(m)}`);
  const numbered: unknown[] = shown.map((m, i) => ({ type: 2, style: 5, label: `${i + 1} · ${m.repo}#${m.number}`.slice(0, 80), url: m.url }));
  const all = [...numbered, ...buttons];
  const rows: unknown[] = [];
  for (let i = 0; i < all.length; i += ROW_BUTTONS) rows.push({ type: 1, components: all.slice(i, i + ROW_BUTTONS) });
  return {
    components: buttons.length ? [...sections, { type: 1, components: buttons }] : sections,
    flags: IS_COMPONENTS_V2,
    legacy: { content: lines.length ? lines.join("\n") : "No matching issue found.", components: rows },
  };
}
