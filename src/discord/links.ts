// Links between a Discord account and a dashboard login. The Discord user id is never stored: a link holds its keyed hash.
// A signed-in dashboard user asks for a short single-use code and types it into the bot in Discord (`/autocraft account action:link`), so
// the link is always made by the person who controls both accounts. Codes are stored as keyed hashes and expire.
import { randomInt } from "node:crypto";
import type { DiscordKeys } from "./keys.ts";
import type { Db } from "../db/index.ts";
import * as access from "../data/access/index.ts";

export const CODE_TTL_MS = 10 * 60_000;
const CODE_LENGTH = 8;
/** No 0/O, 1/I/L: a code is read off one screen and typed into another. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const userHash = (keys: DiscordKeys, discordUserId: string): string => keys.hash("author", discordUserId);
const codeHash = (keys: DiscordKeys, code: string): string => keys.sign("link-code", code.toUpperCase().replace(/[^A-Z0-9]/g, ""));

/** A new code for `login`; an earlier unused code of the login stops working. */
export async function createLinkCode(db: Db, keys: DiscordKeys, login: string, now = Date.now()): Promise<{ code: string; expiresAt: string }> {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  const expiresAt = new Date(now + CODE_TTL_MS).toISOString();
  await access.makeLinkCode(db, { codeHash: codeHash(keys, code), login, expiresAt }, new Date(now).toISOString());
  return { code, expiresAt };
}

/** Spends a code and links `discordUserId` to the login the code was made for. Returns the login, or null for a wrong, used or expired code. A Discord account has one login, so an earlier link of it is replaced. */
export const redeemLinkCode = async (db: Db, keys: DiscordKeys, code: string, discordUserId: string, now = Date.now()): Promise<string | null> =>
  await access.redeemLinkCode(db, codeHash(keys, code), userHash(keys, discordUserId), new Date(now).toISOString());

/** The dashboard login linked to a Discord user, or null. */
export const loginOf = async (db: Db, keys: DiscordKeys, discordUserId: string): Promise<string | null> =>
  (await access.loginsOfLinks(db, [userHash(keys, discordUserId)])).get(userHash(keys, discordUserId)) ?? null;

/**
 * GitHub actors need an AutoCraft login as well as write access to run commands: the Discord account's link must have been made
 * with a dashboard code (a link from the /verify pages proves only the GitHub account), and the login must have an access row.
 */
export async function mayCommand(db: Db, keys: DiscordKeys, discordUserId: string, login: string): Promise<boolean> {
  const [code, rows] = await Promise.all([access.hasCodeLink(db, userHash(keys, discordUserId)), access.loadAccess(db, [login])]);
  return code && rows.has(login.toLowerCase());
}

/** Removes every link of a login; returns how many. */
export const unlinkLogin = async (db: Db, login: string): Promise<number> => await access.unlinkLogins(db, [login]);

/** Removes one link by its row id (the keyed hash); returns the login it belonged to, or null. */
export const unlinkRow = async (db: Db, id: string): Promise<string | null> => await access.unlinkRow(db, id);

/** Part of a deletion request by Discord user id. */
export const forgetLink = async (db: Db, keys: DiscordKeys, discordUserId: string): Promise<number> =>
  await access.forgetLinks(db, [userHash(keys, discordUserId)]);

export type LinkRow = { id: string; login: string; linkedAt: string };
export const listLinks = async (db: Db): Promise<LinkRow[]> =>
  (await access.listLinks(db)).map((r) => ({ id: r.user_hash, login: r.login, linkedAt: r.linked_at }));

export const linkedSince = async (db: Db, login: string): Promise<string | null> =>
  (await access.linkedSince(db, [login])).get(login.toLowerCase()) ?? null;
