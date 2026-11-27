// Discord mentions: the admin page's data and writes, and what the item page shows. The channel list and the
// connection state are written by the runner's gateway client (src/discord/); this file only reads them.
import type { DiscordAccount, DiscordFilingAdded, DiscordLinkCode, DiscordInfo, DiscordSetup, DiscordUsage } from "../../../web/src/api/types.ts";
import { envVar } from "../../env.ts";
import { listLinks as loadLinks } from "../../data/access/index.ts";
import { setting, settings, writeSetting } from "../../data/control/index.ts";
import { loadChannelNames, loadDiscordSetup, loadMentionCounts, loadMentionsOfItems, markWatched, offeredRepos, setDefaultRepo, type MentionRow } from "../../data/discord/index.ts";
import { loadPromptSpend } from "../../data/inference/index.ts";
import { loadReleaseAppNames } from "../../data/mirror/index.ts";
import { readsUseApp } from "../../data/access/index.ts";
import { audit } from "../../discord/audit.ts";
import { isPublicRepo, publicRepoNames } from "../../public/status.ts";
import { HttpError } from "../server/util.ts";
import { DISCORD_PRIVACY_PATH } from "../server/discord-privacy.ts";
import { readKeyFile, type DiscordKeys } from "../../discord/keys.ts";
import { mentionLinks, messageUrl, trackedRepos } from "../../discord/store.ts";
import { addFilingRepo, FilingRepoError, modesOf, offerOf, removeFilingRepo, setOffered } from "../../discord/filing-repos.ts";
import { DEFAULT_REACT_EMOJI, setReactEmoji, validReactEmoji } from "../../discord/react.ts";
import { createLinkCode, linkedSince, unlinkLogin, unlinkRow } from "../../discord/links.ts";
import { ROLE_CHANNEL_KEY, ROLE_ID_KEY, RoleConfigError, rolePanelState, setRoleConfig } from "../../discord/role-panel.ts";
import type { Req } from "../types.ts";
import type { Db } from "../../db/index.ts";
import { interactiveTakers } from "../../health-checks.ts";

const PRIVACY_PATH = DISCORD_PRIVACY_PATH;

let cached: { file: string; keys: DiscordKeys } | null = null;
/** The key file's keys, when this process has AUTOCRAFT_DISCORD_KEY_FILE and the file is sound; message links need them. */
export function discordKeys(): DiscordKeys | null {
  const file = envVar("DISCORD_KEY_FILE");
  if (!file) return null;
  if (cached?.file === file) return cached.keys;
  try {
    cached = { file, keys: readKeyFile(file) };
    return cached.keys;
  } catch {
    // Not cached: a file that is fixed later works at the next request. The page shows counts without links meanwhile.
    return null;
  }
}

export const contactOf = async (db: Db): Promise<string> =>
  (await setting(db, "discord_contact")) ?? "";

/** Count for everyone who sees the item; message links only with the key. */
export async function discordOf(db: Db, repo: string, n: number): Promise<DiscordInfo> {
  const keys = discordKeys();
  const key = `${repo}#${n}`;
  const [counts, mentions] = await db.together(() => Promise.all([loadMentionCounts(db, [key]), keys ? loadMentionsOfItems(db, [key]) : Promise.resolve(null)]));
  const c = counts.get(key), rows = mentions?.get(key) ?? [];
  return { count: c?.count ?? 0, links: mentionLinks(keys, rows), signals: c?.signals ?? 0, signalLinks: mentionLinks(keys, rows.filter((r) => r.signal)) };
}

/** A mention of an item, opened: the message link, its time and the channel's name. */
export type ItemMention = { msgHash: string; url: string; at: string; channel: string | null };

/**
 * The mention rows the key opens, oldest first, each with its channel's name (null for a channel the bot cannot see). Rows the key
 * cannot open, and every row when there is no key, are left out. No message text is stored, so none is shown.
 */
export async function openMentions(db: Db, rows: readonly MentionRow[]): Promise<ItemMention[]> {
  const keys = discordKeys();
  if (!keys || !rows.length) return [];
  const opened = rows.flatMap((r) => { const v = keys.open(r.sealed, r.msgHash); return v ? [{ msgHash: r.msgHash, v }] : []; });
  if (!opened.length) return [];
  const names = await loadChannelNames(db, opened.map((o) => o.v.channelId));
  return opened.map(({ msgHash, v }): ItemMention => {
    const name = names.get(v.channelId) ?? null;
    return { msgHash, url: messageUrl(v), at: v.at, channel: name && !PLACEHOLDER_NAME.test(name) ? name : null };
  }).sort((a, b) => a.at.localeCompare(b.at) || a.msgHash.localeCompare(b.msgHash));
}

const operator = (req: Req): void => {
  if (req.user.role !== "operator") throw new HttpError(403, "only operators use the Discord settings");
};
const body = (req: Req): Record<string, unknown> => (req.json && typeof req.json === "object" ? (req.json as Record<string, unknown>) : {});

const DAY_MS = 24 * 60 * 60 * 1000;

type SetupFacts = Awaited<ReturnType<typeof loadDiscordSetup>>;

/** The usage block from what the page's wave loaded. */
function usageFrom(o: { data: SetupFacts; prompts: Awaited<ReturnType<typeof loadPromptSpend>>; capacity: Awaited<ReturnType<typeof interactiveTakers>>; filingOwner: ReadonlyMap<string, string> }): DiscordUsage {
  return {
    counts: o.data.eventCounts,
    prompts: o.prompts.map((p) => ({ prompt: p.prompt, day: { calls: p.dayCalls, usd: p.dayUsd }, week: { calls: p.weekCalls, usd: p.weekUsd } })),
    filed: o.data.recentFiled.map((f) => {
      const owner = o.filingOwner.get(f.repo);
      return { repo: f.repo, number: f.number, login: f.login, at: f.at, githubUrl: owner ? `https://github.com/${owner}/${f.repo}/issues/${f.number}` : null };
    }),
    capacity: o.capacity.applies ? { ready: o.capacity.ready, why: o.capacity.why } : null,
  };
}

/** Names like "___hidden___" that Discord shows for channels the bot cannot see. */
const PLACEHOLDER_NAME = /^_+hidden_+$/i;

async function setupOf(db: Db, now: number = Date.now()): Promise<DiscordSetup> {
  const [data, publicNames, tracked, stored, links, prompts, capacity, app, posted] = await db.together(() => Promise.all([
    loadDiscordSetup(db, { nowMs: now }), publicRepoNames(db), trackedRepos(db), settings(db, ["discord_contact", "discord_react", "discord_react_emoji", ROLE_CHANNEL_KEY, ROLE_ID_KEY]),
    loadLinks(db), loadPromptSpend(db, "discord.", new Date(now - DAY_MS).toISOString(), new Date(now - 7 * DAY_MS).toISOString()), interactiveTakers(db, now), readsUseApp(db),
    rolePanelState(db),
  ]));
  const [labels, filingRepos] = await Promise.all([loadReleaseAppNames(db, publicNames), modesOf(data.filing, app)]);
  const filingOwner = new Map(offeredRepos({ tracked, publicNames, hidden: data.hidden, filing: data.filing }).filter((r) => r.filingOnly).map((r) => [r.name, r.owner]));
  const st = data.status;
  const emoji = stored.get("discord_react_emoji");
  return {
    state: (st?.state ?? "off") as DiscordSetup["state"], detail: st?.detail ?? null, at: st?.at ?? null,
    channels: data.channels.filter((c) => c.watched || !PLACEHOLDER_NAME.test(c.name ?? "")),
    repos: publicNames,
    filingRepos,
    offer: offerOf({ filing: data.filing, hidden: data.hidden, publicNames, tracked, labels }),
    contact: stored.get("discord_contact") ?? "", reactOn: stored.get("discord_react") !== "off", reactEmoji: emoji && validReactEmoji(emoji) ? emoji : DEFAULT_REACT_EMOJI,
    privacyPath: PRIVACY_PATH, links: links.map((l) => ({ id: l.user_hash, login: l.login, linkedAt: l.linked_at })),
    usage: usageFrom({ data, prompts, capacity, filingOwner }),
    rolePanel: rolePanelOf(data.channels, stored.get(ROLE_CHANNEL_KEY) ?? null, stored.get(ROLE_ID_KEY) ?? null, posted),
  };
}

/** The settings with the channel's guild; `posted` only when it is about the configured channel. */
function rolePanelOf(channels: { channelId: string; guildId: string }[], channelId: string | null, roleId: string | null, st: Awaited<ReturnType<typeof rolePanelState>>): DiscordSetup["rolePanel"] {
  const on = channelId !== null && roleId !== null;
  return {
    channelId: on ? channelId : null, roleId: on ? roleId : null,
    guildId: on ? channels.find((c) => c.channelId === channelId)?.guildId ?? null : null,
    posted: on && st?.channelId === channelId ? { messageId: st.messageId, error: st.error, at: st.at } : null,
  };
}

export async function setup(db: Db, req: Req): Promise<DiscordSetup> {
  operator(req);
  return await setupOf(db);
}

export async function putChannel(db: Db, req: Req): Promise<DiscordSetup> {
  operator(req);
  const id = body(req).channelId, watched = body(req).watched;
  if (typeof id !== "string" || typeof watched !== "boolean") throw new HttpError(400, "channelId and watched are required");
  await db.write(async () => {
    if (!await markWatched(db, id, watched)) throw new HttpError(404, "the bot has not reported that channel");
    await audit(db, req.user.login, watched ? "discord-watch" : "discord-unwatch", id);
  });
  return await setupOf(db);
}

export async function putChannelRepo(db: Db, req: Req): Promise<DiscordSetup> {
  operator(req);
  const id = body(req).channelId, repo = body(req).repo;
  if (typeof id !== "string" || (repo !== null && typeof repo !== "string")) throw new HttpError(400, "channelId and repo (a tracked repo or null) are required");
  if (repo !== null && !await isPublicRepo(db, repo)) throw new HttpError(400, "repo is not a public tracked repo");
  await db.write(async () => {
    if (!await setDefaultRepo(db, id, repo)) throw new HttpError(404, "the bot has not reported that channel");
    await audit(db, req.user.login, "discord-default-repo", id, { repo });
  });
  return await setupOf(db);
}

export async function putContact(db: Db, req: Req): Promise<DiscordSetup> {
  operator(req);
  const c = body(req).contact;
  if (typeof c !== "string" || c.length > 300) throw new HttpError(400, "contact must be text of at most 300 characters");
  await db.write(async () => {
    await writeSetting(db, "discord_contact", c.trim());
    await audit(db, req.user.login, "discord-contact", null);
  });
  return await setupOf(db);
}

/** Adds a filing-only repo (`repo`: owner/name) once GitHub confirms it is public with issues on; the refusal's reason is the error. `added` says whether it is link-only, and why. */
export async function addFiling(db: Db, req: Req): Promise<DiscordFilingAdded> {
  operator(req);
  const repo = body(req).repo;
  if (typeof repo !== "string" || repo.length > 200) throw new HttpError(400, "repo (owner/name) is required");
  try {
    const r = await addFilingRepo(db, req.user.login, repo);
    return { ...await setupOf(db), added: { owner: r.owner, name: r.name, mode: r.mode, why: r.why ?? null } };
  } catch (e) {
    if (e instanceof FilingRepoError) throw new HttpError(400, e.message);
    throw e;
  }
}

export async function removeFiling(db: Db, req: Req): Promise<DiscordSetup> {
  operator(req);
  const repo = body(req).repo;
  if (typeof repo !== "string") throw new HttpError(400, "repo is required");
  if (!await removeFilingRepo(db, req.user.login, repo)) throw new HttpError(404, "not a filing-only repo");
  return await setupOf(db);
}

/** Offers (`on`: true) or hides one public tracked repo in the bot's repo select. */
export async function setOffer(db: Db, req: Req): Promise<DiscordSetup> {
  operator(req);
  const { repo, on } = body(req);
  if (typeof repo !== "string" || typeof on !== "boolean") throw new HttpError(400, "repo and on (true or false) are required");
  if (!await setOffered(db, req.user.login, repo, on)) throw new HttpError(404, "not a public tracked repo");
  return await setupOf(db);
}

/** Sets the Reactions switch (`on`) and/or the reaction emoji (`emoji`: a custom emoji name or one Unicode emoji). */
export async function putReact(db: Db, req: Req): Promise<DiscordSetup> {
  operator(req);
  const { on, emoji } = body(req);
  if (on === undefined && emoji === undefined) throw new HttpError(400, "on or emoji is required");
  if (on !== undefined && typeof on !== "boolean") throw new HttpError(400, "on must be true or false");
  if (emoji !== undefined && (typeof emoji !== "string" || !validReactEmoji(emoji.trim()))) throw new HttpError(400, "emoji must be a custom emoji name (2-32 letters, digits or underscores) or one Unicode emoji");
  if (typeof on === "boolean") {
    await db.write(async () => {
      await writeSetting(db, "discord_react", on ? "on" : "off");
      await audit(db, req.user.login, on ? "discord-react-on" : "discord-react-off", null);
    });
  }
  if (typeof emoji === "string") {
    await db.write(async () => {
      await setReactEmoji(db, emoji.trim());
      await audit(db, req.user.login, "discord-react-emoji", emoji.trim());
    });
  }
  return await setupOf(db);
}

/** Whether the signed-in user has a Discord account linked, and whether this server can make link codes (it has the key file). */
export const account = async (db: Db, req: Req): Promise<DiscordAccount> => {
  const at = await linkedSince(db, req.user.login);
  return { linked: at !== null, at, configured: discordKeys() !== null };
};

/** A single-use code, valid for 10 minutes, that links a Discord account to the signed-in login when typed into the bot's `/autocraft account action:link`. */
export async function linkCode(db: Db, req: Req): Promise<DiscordLinkCode> {
  const keys = discordKeys();
  if (!keys) throw new HttpError(503, "Discord is not set up on this server");
  const c = await createLinkCode(db, keys, req.user.login);
  await audit(db, req.user.login, "discord-link-code", req.user.login);
  return c;
}

export async function unlinkOwn(db: Db, req: Req): Promise<DiscordAccount> {
  const n = await unlinkLogin(db, req.user.login);
  if (n) await audit(db, req.user.login, "discord-unlink", req.user.login, { links: n });
  return await account(db, req);
}

export async function removeLink(db: Db, req: Req): Promise<DiscordSetup> {
  operator(req);
  const id = body(req).id;
  if (typeof id !== "string") throw new HttpError(400, "id is required");
  const login = await unlinkRow(db, id);
  if (login === null) throw new HttpError(404, "no such link");
  await audit(db, req.user.login, "discord-unlink", login, { by: "operator" });
  return await setupOf(db);
}

/** Sets the contributor role panel (`channelId` and `roleId`) or turns it off (`off: true`); the runner posts or removes the panel. */
export async function putRolePanel(db: Db, req: Req): Promise<DiscordSetup> {
  operator(req);
  const { channelId, roleId, off } = body(req);
  if (off !== true && (typeof channelId !== "string" || typeof roleId !== "string")) throw new HttpError(400, "channelId and roleId, or off: true, are required");
  try {
    await setRoleConfig(db, req.user.login, off === true ? null : { channelId: channelId as string, roleId: roleId as string });
  } catch (e) {
    if (e instanceof RoleConfigError) throw new HttpError(400, e.message);
    throw e;
  }
  return await setupOf(db);
}
