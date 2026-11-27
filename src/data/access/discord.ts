// Discord links and link codes (M03 access-a). The keyed hashing stays in src/discord/links.ts: this file takes hashes.
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import type { LinkRow, Login } from "./types.ts";

/** Links keep the login as written, so logins are matched on their lower case. */
const lowered = (logins: Login[]): string[] => [...new Set(logins.map((l) => l.toLowerCase()))];

/** Drops the login's earlier and expired codes, inserts the new one; one `db.write`. */
export async function makeLinkCode(db: Db, row: { codeHash: string; login: Login; expiresAt: string }, now: string): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    await q.run(q.k.deleteFrom("main.discord_link_codes").where((eb) => eb.or([eb("login", "=", row.login), eb("expires_at", "<=", now)])));
    await q.run(q.k.insertInto("main.discord_link_codes").values({ code_hash: row.codeHash, login: row.login, expires_at: row.expiresAt }));
  });
}

/** Deletes the code returning it, upserts the link when unexpired; one `db.write`. */
export async function redeemLinkCode(db: Db, codeHash: string, userHash: string, now: string): Promise<Login | null> {
  const q = queryDb(db);
  return await db.write(async () => {
    const code = await q.get(q.k.deleteFrom("main.discord_link_codes").where("code_hash", "=", codeHash).returning(["login", "expires_at"]));
    if (!code || Date.parse(code.expires_at) <= Date.parse(now)) return null;
    // A Discord account has one login, so an earlier link of it is replaced.
    await q.run(q.k.insertInto("main.discord_links").values({ user_hash: userHash, login: code.login, linked_at: now, source: "code" })
      .onConflict((oc) => oc.column("user_hash").doUpdateSet(kx.excluded(["login", "linked_at", "source"]))));
    return code.login;
  });
}

/**
 * Links a Discord user hash to a login proven by GitHub sign-in (the /verify pages), source verify. An earlier verify link of the
 * account is replaced; a link made with a dashboard code is kept as it is.
 */
export async function linkProven(db: Db, userHash: string, login: Login, now: string): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.discord_links").values({ user_hash: userHash, login, linked_at: now, source: "verify" })
    .onConflict((oc) => oc.column("user_hash").doUpdateSet(kx.excluded(["login", "linked_at"])).where("main.discord_links.source", "=", "verify")));
}

/** True when the Discord user hash has a link made with a dashboard code (the only links that run commands). */
export async function hasCodeLink(db: Db, userHash: string): Promise<boolean> {
  const q = queryDb(db);
  return !!(await q.get(q.k.selectFrom("main.discord_links").select("user_hash").where("user_hash", "=", userHash).where("source", "=", "code")));
}

/** Login per Discord user hash. */
export async function loginsOfLinks(db: Db, userHashes: string[]): Promise<Map<string, Login>> {
  const out = new Map<string, Login>();
  if (!userHashes.length) return out;
  const q = queryDb(db);
  for (const part of kx.chunks(userHashes)) {
    for (const r of await q.all(q.k.selectFrom("main.discord_links").select(["user_hash", "login"]).where(kx.inList(db, "user_hash", part)))) out.set(r.user_hash, r.login);
  }
  return out;
}

/** Every link. */
export async function listLinks(db: Db): Promise<LinkRow[]> {
  const q = queryDb(db);
  return await q.all(q.k.selectFrom("main.discord_links").selectAll().orderBy("login").orderBy("linked_at"));
}

/** Earliest link time per lower-cased login. */
export async function linkedSince(db: Db, logins: Login[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!logins.length) return out;
  const q = queryDb(db);
  for (const part of kx.chunks(lowered(logins))) {
    const rows = await q.all(q.k.selectFrom("main.discord_links").select(["login", (eb) => eb.fn.min<string>("linked_at").as("at")])
      .where(kx.inList(db, q.k.fn("lower", ["login"]), part)).groupBy("login"));
    for (const r of rows) {
      const k = r.login.toLowerCase();
      const prev = out.get(k);
      if (prev === undefined || r.at < prev) out.set(k, r.at);
    }
  }
  return out;
}

/** Deletes links. */
export async function unlinkLogins(db: Db, logins: Login[]): Promise<number> {
  if (!logins.length) return 0;
  const q = queryDb(db);
  let n = 0;
  for (const part of kx.chunks(lowered(logins))) n += Number((await q.run(q.k.deleteFrom("main.discord_links").where(kx.inList(db, q.k.fn("lower", ["login"]), part)))).changes);
  return n;
}

/** `DELETE ... RETURNING login`. */
export async function unlinkRow(db: Db, userHash: string): Promise<Login | null> {
  const q = queryDb(db);
  return (await q.get(q.k.deleteFrom("main.discord_links").where("user_hash", "=", userHash).returning("login")))?.login ?? null;
}

/** Batched delete. */
export async function forgetLinks(db: Db, userHashes: string[]): Promise<number> {
  if (!userHashes.length) return 0;
  const q = queryDb(db);
  let n = 0;
  for (const part of kx.chunks(userHashes)) n += Number((await q.run(q.k.deleteFrom("main.discord_links").where(kx.inList(db, "user_hash", part)))).changes);
  return n;
}
