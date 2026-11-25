// user_tokens: the GitHub App user token of each login, written at every
// sign-in while the GitHub identity is the app. It holds the sealed JSON of
// the whole token set, like sessions.token_enc, but is keyed by login so the
// act stage can act for a login without a live session. The vault
// (src/github/vault.ts) refreshes it through refreshShared (token-refresh.ts).
import type { TokenBox } from "./crypto.ts";
import type { Tokens } from "./provider.ts";
import type { Db } from "../../db/index.ts";

const aad = (login: string): string => `user_tokens:${login.toLowerCase()}`;

export async function saveUserTokens(db: Db, box: TokenBox, login: string, githubId: number, tokens: Tokens): Promise<void> {
  await db.run(db.k.insertInto("user_tokens")
    .values({ login, github_id: githubId, token_enc: box.seal(JSON.stringify(tokens), aad(login)), version: 1, updated_at: new Date().toISOString(), status: "ok" })
    .onConflict((oc) => oc.column("login").doUpdateSet((eb) => ({
      github_id: eb.ref("excluded.github_id"), token_enc: eb.ref("excluded.token_enc"), version: eb("user_tokens.version", "+", 1),
      updated_at: eb.ref("excluded.updated_at"), status: "ok", refresh_error: null,
    }))));
}

export async function loadUserTokens(db: Db, box: TokenBox, login: string): Promise<Tokens | null> {
  const row = await db.get(db.k.selectFrom("user_tokens").select("token_enc").where("login", "=", login).where("status", "=", "ok"));
  const plain = row ? box.open(row.token_enc, aad(login)) : null;
  try {
    return plain ? (JSON.parse(plain) as Tokens) : null;
  } catch {
    return null;
  }
}

/** The login's row with its opened tokens, whatever its status (null tokens: unreadable). */
export async function readUserTokens(db: Db, box: TokenBox, login: string): Promise<{ tokens: Tokens | null; version: number; status: string } | null> {
  const row = await db.get(db.k.selectFrom("user_tokens").select(["token_enc", "version", "status"]).where("login", "=", login));
  if (!row) return null;
  const plain = box.open(row.token_enc, aad(login));
  let tokens: Tokens | null = null;
  try {
    tokens = plain ? (JSON.parse(plain) as Tokens) : null;
  } catch { /* unreadable: the caller treats it as no token */ }
  return { tokens, version: Number(row.version), status: row.status };
}

/**
 * Stores a token set if the row still has `version` (compare-and-swap: a new sign-in may have written first), whatever
 * its status: a row healed from a session's newer token set is usable again. Returns false when it lost.
 */
export async function swapUserTokens(db: Db, box: TokenBox, login: string, version: number, tokens: Tokens): Promise<boolean> {
  return Number((await db.run(db.k.updateTable("user_tokens")
    .set((eb) => ({ token_enc: box.seal(JSON.stringify(tokens), aad(login)), version: eb("version", "+", 1), updated_at: new Date().toISOString(), status: "ok", refresh_error: null }))
    .where("login", "=", login).where("version", "=", version))).changes) > 0;
}

/** Marks the row as needing a new sign-in, with the reason (never a token value), if it still has `version`. Returns false when it lost. */
export async function failUserTokens(db: Db, login: string, version: number, reason: string): Promise<boolean> {
  return Number((await db.run(db.k.updateTable("user_tokens")
    .set((eb) => ({ status: "refresh-failed", refresh_error: reason, version: eb("version", "+", 1), updated_at: new Date().toISOString() }))
    .where("login", "=", login).where("version", "=", version).where("status", "=", "ok"))).changes) > 0;
}

/**
 * Deletes the login's row because its access was removed (a removed login, a role change) and queues its whole GitHub
 * authorization for revocation; the dashboard's vault does that later. Returns whether a row existed.
 * Not for ending one session: that is dropSessionTokens.
 */
export async function dropUserTokens(db: Db, login: string): Promise<boolean> {
  const row = await db.get(db.k.deleteFrom("user_tokens").where("login", "=", login).returning("token_enc"));
  if (!row) return false;
  await db.run(db.k.insertInto("user_token_revocations").values({ login, token_enc: row.token_enc, queued_at: new Date().toISOString(), kind: "grant" }));
  return true;
}

/**
 * Ends one session's GitHub App token: queues that token alone for revocation, so the login's other sign-ins keep their
 * tokens and the authorization stays. The vault's sweep also deletes the login's user_tokens row once the revoke
 * succeeds, but only when the row holds that same token set (it was written by the same sign-in).
 */
export async function dropSessionTokens(db: Db, login: string, idHash: string, tokenEnc: string | null): Promise<boolean> {
  if (!tokenEnc) return false;
  await db.run(db.k.insertInto("user_token_revocations").values({ login, token_enc: tokenEnc, queued_at: new Date().toISOString(), kind: "token", aad: idHash }));
  return true;
}

export const revocationAad = aad;
