// Discord mentions: the admin page's data and writes, and what the item page shows. The channel list and the
// connection state are written by the runner's gateway client (src/discord/); this file only reads them.
import type { DiscordAccount, DiscordLinkCode, DiscordInfo, DiscordSetup, DiscordUsage } from "../../../web/src/api/types.ts";
import { envVar } from "../../env.ts";
import { excluded } from "../../db/kx.ts";
import { audit } from "../audit.ts";
import { isPublicRepo, publicRepoNames } from "../../public/status.ts";
import { HttpError } from "../server/util.ts";
import { DISCORD_PRIVACY_PATH } from "../server/discord-privacy.ts";
import { readKeyFile, type DiscordKeys } from "../../discord/keys.ts";
import { countOf, linksOf } from "../../discord/store.ts";
import { addFilingRepo, botRepos, filingRepos, FilingRepoError, offerState, removeFilingRepo, setOffered } from "../../discord/filing-repos.ts";
import { reactOn } from "../../discord/react.ts";
import { signalCountOf, signalLinks } from "../../discord/signals.ts";
import { createLinkCode, linkedSince, listLinks, unlinkLogin, unlinkRow } from "../../discord/links.ts";
import type { Req } from "../types.ts";
import type { Db } from "../../db/index.ts";
import { setting } from "../../settings-read.ts";
import { eventCounts } from "../../discord/events.ts";
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
  return { count: await countOf(db, repo, n), links: await linksOf(db, keys, repo, n), signals: await signalCountOf(db, repo, n), signalLinks: await signalLinks(db, keys, repo, n) };
}

const operator = (req: Req): void => {
  if (req.user.role !== "operator") throw new HttpError(403, "only operators use the Discord settings");
};
const body = (req: Req): Record<string, unknown> => (req.json && typeof req.json === "object" ? (req.json as Record<string, unknown>) : {});

const DAY_MS = 24 * 60 * 60 * 1000;

/** Counters, the cost of the Discord prompts, the issues filed in the last day (the limits table keeps no more) and whether a Task Runner takes Discord calls. */
export async function usageOf(db: Db, now: number = Date.now()): Promise<DiscordUsage> {
  const day = new Date(now - DAY_MS).toISOString(), week = new Date(now - 7 * DAY_MS).toISOString();
  const runs = await db.all(db.k.selectFrom("agent_runs").select(["prompt_id as prompt", "started_at as at", "cost_usd as cost"]).where("prompt_id", "like", "discord.%").where("started_at", ">=", week));
  const byPrompt = new Map<string, DiscordUsage["prompts"][number]>();
  for (const r of runs) {
    const p = byPrompt.get(r.prompt) ?? { prompt: r.prompt, day: { calls: 0, usd: 0 }, week: { calls: 0, usd: 0 } };
    byPrompt.set(r.prompt, p);
    for (const w of r.at >= day ? [p.day, p.week] : [p.week]) { w.calls++; w.usd += r.cost ?? 0; }
  }
  const filed = await db.all(db.k.selectFrom("discord_filed").select(["repo", "number", "login", "at"]).where("number", ">", 0).orderBy("at", "desc").limit(20));
  const cap = await interactiveTakers(db, now);
  const filingOwner = new Map((await botRepos(db)).filter((r) => r.filingOnly).map((r) => [r.name, r.owner]));
  return {
    counts: await eventCounts(db, now),
    prompts: [...byPrompt.values()].sort((a, b) => a.prompt.localeCompare(b.prompt)),
    filed: filed.map((f) => {
      const owner = filingOwner.get(f.repo);
      return { repo: f.repo, number: Number(f.number), login: f.login, at: f.at, githubUrl: owner ? `https://github.com/${owner}/${f.repo}/issues/${Number(f.number)}` : null };
    }),
    capacity: cap.applies ? { ready: cap.ready, why: cap.why } : null,
  };
}

async function setupOf(db: Db): Promise<DiscordSetup> {
  const st = await db.get(db.k.selectFrom("discord_status").select(["state", "detail", "at"]).where("id", "=", 1).$narrowType<{ state: DiscordSetup["state"] }>());
  const channels = await db.all(db.k.selectFrom("discord_channels as c")
    .leftJoin("discord_categories as k", (j) => j.onRef("k.category_id", "=", "c.category_id").onRef("k.guild_id", "=", "c.guild_id"))
    .select(["c.channel_id as channelId", "c.guild_id as guildId", "c.guild_name as guildName", "c.name", "c.watched", "c.default_repo as defaultRepo", "k.name as category"])
    .where("c.parent_id", "is", null)
    .orderBy("c.guild_name", (o) => o.asc().nullsFirst()).orderBy("c.guild_id")
    .orderBy((eb) => eb("k.category_id", "is not", null)).orderBy((eb) => eb("k.position", "is", null))
    .orderBy("k.position", (o) => o.asc().nullsFirst()).orderBy("k.category_id", (o) => o.asc().nullsFirst())
    .orderBy((eb) => eb("c.position", "is", null)).orderBy("c.position", (o) => o.asc().nullsFirst()).orderBy("c.channel_id"));
  return {
    state: st?.state ?? "off", detail: st?.detail ?? null, at: st?.at ?? null,
    channels: channels.map((c) => ({ ...c, watched: !!c.watched })),
    repos: await publicRepoNames(db),
    filingRepos: await filingRepos(db),
    offer: await offerState(db),
    contact: await contactOf(db), reactOn: await reactOn(db), privacyPath: PRIVACY_PATH, links: await listLinks(db),
    usage: await usageOf(db),
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
  const r = await db.run(db.k.updateTable("discord_channels").set({ watched: watched ? 1 : 0 }).where("channel_id", "=", id));
  if (!r.changes) throw new HttpError(404, "the bot has not reported that channel");
  await audit(db, req.user.login, watched ? "discord-watch" : "discord-unwatch", id);
  return await setupOf(db);
}

export async function putChannelRepo(db: Db, req: Req): Promise<DiscordSetup> {
  operator(req);
  const id = body(req).channelId, repo = body(req).repo;
  if (typeof id !== "string" || (repo !== null && typeof repo !== "string")) throw new HttpError(400, "channelId and repo (a tracked repo or null) are required");
  if (repo !== null && !await isPublicRepo(db, repo)) throw new HttpError(400, "repo is not a public tracked repo");
  const r = await db.run(db.k.updateTable("discord_channels").set({ default_repo: repo }).where("channel_id", "=", id));
  if (!r.changes) throw new HttpError(404, "the bot has not reported that channel");
  await audit(db, req.user.login, "discord-default-repo", id, { repo });
  return await setupOf(db);
}

export async function putContact(db: Db, req: Req): Promise<DiscordSetup> {
  operator(req);
  const c = body(req).contact;
  if (typeof c !== "string" || c.length > 300) throw new HttpError(400, "contact must be text of at most 300 characters");
  await db.run(db.k.insertInto("settings").values({ key: "discord_contact", value: c.trim() }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
  await audit(db, req.user.login, "discord-contact", null);
  return await setupOf(db);
}

/** Adds a filing-only repo (`repo`: owner/name) once GitHub confirms it; the refusal's reason is the error. */
export async function addFiling(db: Db, req: Req): Promise<DiscordSetup> {
  operator(req);
  const repo = body(req).repo;
  if (typeof repo !== "string" || repo.length > 200) throw new HttpError(400, "repo (owner/name) is required");
  try {
    await addFilingRepo(db, req.user.login, repo);
  } catch (e) {
    if (e instanceof FilingRepoError) throw new HttpError(400, e.message);
    throw e;
  }
  return await setupOf(db);
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

export async function putReact(db: Db, req: Req): Promise<DiscordSetup> {
  operator(req);
  const on = body(req).on;
  if (typeof on !== "boolean") throw new HttpError(400, "on must be true or false");
  await db.run(db.k.insertInto("settings").values({ key: "discord_react", value: on ? "on" : "off" }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
  await audit(db, req.user.login, on ? "discord-react-on" : "discord-react-off", null);
  return await setupOf(db);
}

/** Whether the signed-in user has a Discord account linked, and whether this server can make link codes (it has the key file). */
export const account = async (db: Db, req: Req): Promise<DiscordAccount> => {
  const at = await linkedSince(db, req.user.login);
  return { linked: at !== null, at, configured: discordKeys() !== null };
};

/** A single-use code, valid for 10 minutes, that links a Discord account to the signed-in login when typed into the bot's `/autocraft link`. */
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
