// A Discord reporter's GitHub sign-in: the GitHub App user token that lets the bot file an issue as that person. Keyed by
// the Discord user's keyed hash, sealed like user_tokens (src/dash/server/user-tokens.ts) with an AAD that names this
// table and the reporter, so a row cannot be moved into user_tokens or another reporter. A reporter is not a dashboard
// user: there is no session and no access. Only the runner refreshes these tokens, so no cross-process compare-and-swap
// beyond the row's version is needed.
import { createHash, randomBytes } from "node:crypto";
import type { TokenBox } from "../dash/server/crypto.ts";
import type { Provider, Refused, Tokens } from "../dash/server/provider.ts";
import type { Db } from "../db/index.ts";
import * as access from "../data/access/index.ts";
import type { Sealed } from "../data/access/index.ts";
import { forgetFiledOf } from "../data/discord/index.ts";

const aad = (reporter: string): string => `reporter_tokens:${reporter}`;
const hashOf = (state: string): string => createHash("sha256").update(state).digest("hex");
const EXPIRY_MARGIN = 60_000;
export const STATE_TTL_MS = 10 * 60_000;

/** Stores the sign-in. A token the reporter had before is queued for revocation (a new sign-in replaces it). */
export async function saveReporter(db: Db, box: TokenBox, reporter: string, githubId: number, login: string, tokens: Tokens, now = Date.now()): Promise<void> {
  await access.saveReporter(db, { reporter, githubId, login, sealed: box.seal(JSON.stringify(tokens), aad(reporter)) as Sealed, now: new Date(now).toISOString() });
}

export async function readReporter(db: Db, box: TokenBox, reporter: string): Promise<{ login: string; tokens: Tokens | null; version: number; status: string } | null> {
  const row = await access.loadReporterSealed(db, reporter);
  if (!row) return null;
  const plain = box.open(row.sealed, aad(reporter));
  let tokens: Tokens | null = null;
  try { tokens = plain ? (JSON.parse(plain) as Tokens) : null; } catch { /* unreadable: treated as no token */ }
  return { login: row.login, tokens, version: Number(row.version), status: row.status };
}

/** Marks the row as needing a new sign-in, if it still has `version`. */
export const failReporter = async (db: Db, reporter: string, version: number, now = Date.now()): Promise<boolean> =>
  await access.failReporter(db, reporter, version, new Date(now).toISOString());

export type ReporterToken = { ok: true; access: string; login: string; version: number } | { ok: false; signIn: true } | { ok: false; signIn: false };

const inflight = new Map<string, Promise<ReporterToken>>();

/** A usable access token for the reporter, refreshed when it is within a minute of expiry or `rejected` (a token GitHub answered 401 to). `signIn: false` is a transient failure. */
export function reporterToken(db: Db, box: TokenBox, provider: Provider, reporter: string, now = Date.now(), rejected?: string): Promise<ReporterToken> {
  let p = inflight.get(reporter);
  if (!p) {
    p = obtain(db, box, provider, reporter, now, rejected).finally(() => inflight.delete(reporter));
    inflight.set(reporter, p);
  }
  return p;
}

async function obtain(db: Db, box: TokenBox, provider: Provider, reporter: string, now: number, rejected: string | undefined): Promise<ReporterToken> {
  const row = await readReporter(db, box, reporter);
  if (!row?.tokens || row.status !== "ok") return { ok: false, signIn: true };
  const t = row.tokens;
  if (t.access !== rejected && (t.expiresAt === null || t.expiresAt - EXPIRY_MARGIN > now)) return { ok: true, access: t.access, login: row.login, version: row.version };
  if (!t.refresh || (t.refreshExpiresAt !== null && t.refreshExpiresAt <= now)) {
    await failReporter(db, reporter, row.version, now);
    return { ok: false, signIn: true };
  }
  let r: Tokens | Refused;
  try {
    r = await provider.refresh(t.refresh);
  } catch {
    return { ok: false, signIn: false };
  }
  if ("refused" in r) {
    await failReporter(db, reporter, row.version, now);
    return { ok: false, signIn: true };
  }
  const next = r;
  const swapped = await access.swapReporter(db, reporter, row.version, box.seal(JSON.stringify(next), aad(reporter)) as Sealed, new Date(now).toISOString());
  // A sign-in wrote the row while the refresh ran: its token is the one to use.
  if (!swapped) return obtain(db, box, provider, reporter, now, undefined);
  return { ok: true, access: next.access, login: row.login, version: row.version + 1 };
}

/** A new single-use sign-in state for the reporter; only its hash is stored. `verifier` is the PKCE verifier the callback needs. */
export async function newReporterState(db: Db, reporter: string, now = Date.now()): Promise<string> {
  const state = randomBytes(24).toString("base64url");
  await access.addReporterState(db, { stateHash: hashOf(state), reporter, verifier: randomBytes(48).toString("base64url"), expiresAt: new Date(now + STATE_TTL_MS).toISOString() }, { now: new Date(now).toISOString() });
  return state;
}

/** The state's reporter and verifier without using it up (the start route), or null when unknown or expired. */
export const peekReporterState = async (db: Db, state: string, now = Date.now()): Promise<{ reporter: string; verifier: string } | null> =>
  await access.peekReporterState(db, hashOf(state), new Date(now).toISOString());

/** Uses the state up (the callback). */
export const takeReporterState = async (db: Db, state: string, now = Date.now()): Promise<{ reporter: string; verifier: string } | null> =>
  await access.takeReporterState(db, hashOf(state), new Date(now).toISOString());

/** Removes the reporter's sign-in and filing records and queues the token's revoke. Returns whether one existed. */
export const forgetReporterRow = async (db: Db, reporter: string, now = Date.now()): Promise<boolean> =>
  await db.write(async () => {
    await forgetFiledOf(db, reporter);
    return await access.forgetReporterTokens(db, reporter, new Date(now).toISOString());
  });
