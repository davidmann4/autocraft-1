// user_tokens: the GitHub App user token of each login, written at every
// sign-in while the GitHub identity is the app. It holds the sealed JSON of
// the whole token set, like sessions.token_enc, but is keyed by login so the
// act stage can act for a login without a live session. The vault
// (src/github/vault.ts) refreshes it through refreshShared (token-refresh.ts).
import type { TokenBox } from "./crypto.ts";
import type { Tokens } from "./provider.ts";
import * as access from "../../data/access/index.ts";
import type { Sealed } from "../../data/access/index.ts";
import type { Db } from "../../db/index.ts";

const aad = (login: string): string => `user_tokens:${login.toLowerCase()}`;
const sealTokens = (box: TokenBox, login: string, tokens: Tokens): Sealed => box.seal(JSON.stringify(tokens), aad(login)) as Sealed;

export async function saveUserTokens(db: Db, box: TokenBox, login: string, githubId: number, tokens: Tokens): Promise<void> {
  await access.saveUserToken(db, { login, githubId, sealed: sealTokens(box, login, tokens), now: new Date().toISOString() });
}

export async function loadUserTokens(db: Db, box: TokenBox, login: string): Promise<Tokens | null> {
  const row = await access.loadUserTokenSealed(db, login);
  const plain = row?.status === "ok" ? box.open(row.sealed, aad(login)) : null;
  try {
    return plain ? (JSON.parse(plain) as Tokens) : null;
  } catch {
    return null;
  }
}

/** The login's row with its opened tokens, whatever its status (null tokens: unreadable). */
export async function readUserTokens(db: Db, box: TokenBox, login: string): Promise<{ tokens: Tokens | null; version: number; status: string } | null> {
  const row = await access.loadUserTokenSealed(db, login);
  if (!row) return null;
  const plain = box.open(row.sealed, aad(login));
  let tokens: Tokens | null = null;
  try {
    tokens = plain ? (JSON.parse(plain) as Tokens) : null;
  } catch { /* unreadable: the caller treats it as no token */ }
  return { tokens, version: row.version, status: row.status };
}

/**
 * Stores a token set if the row still has `version` (compare-and-swap: a new sign-in may have written first), whatever
 * its status: a row healed from a session's newer token set is usable again. Returns false when it lost.
 */
export async function swapUserTokens(db: Db, box: TokenBox, login: string, version: number, tokens: Tokens): Promise<boolean> {
  return await access.swapUserToken(db, login, version, sealTokens(box, login, tokens), new Date().toISOString());
}

/** Marks the row as needing a new sign-in, with the reason (never a token value), if it still has `version`. Returns false when it lost. */
export async function failUserTokens(db: Db, login: string, version: number, reason: string): Promise<boolean> {
  return await access.failUserToken(db, login, version, new Date().toISOString(), reason);
}

/**
 * Deletes the login's row because its access was removed (a removed login, a role change) and queues its whole GitHub
 * authorization for revocation; the dashboard's vault does that later. Returns whether a row existed.
 * Not for ending one session: that is dropSessionTokens.
 */
export async function dropUserTokens(db: Db, login: string): Promise<boolean> {
  return await access.dropUserTokens(db, [login]) > 0;
}

/**
 * Ends one session's GitHub App token: queues that token alone for revocation, so the login's other sign-ins keep their
 * tokens and the authorization stays. The vault's sweep also deletes the login's user_tokens row once the revoke
 * succeeds, but only when the row holds that same token set (it was written by the same sign-in).
 */
export async function dropSessionTokens(db: Db, login: string, idHash: string, tokenEnc: string | null): Promise<boolean> {
  if (!tokenEnc) return false;
  await access.queueSessionTokenRevocation(db, [{ login, sealed: tokenEnc as Sealed, aad: idHash, now: new Date().toISOString() }]);
  return true;
}

export const revocationAad = aad;
