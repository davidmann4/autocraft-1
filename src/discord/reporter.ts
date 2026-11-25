// A Discord reporter's GitHub sign-in: the GitHub App user token that lets the bot file an issue as that person. Keyed by
// the Discord user's keyed hash, sealed like user_tokens (src/dash/server/user-tokens.ts) with an AAD that names this
// table and the reporter, so a row cannot be moved into user_tokens or another reporter. A reporter is not a dashboard
// user: there is no session and no access. Only the runner refreshes these tokens, so no cross-process compare-and-swap
// beyond the row's version is needed.
import { createHash, randomBytes } from "node:crypto";
import type { TokenBox } from "../dash/server/crypto.ts";
import type { Provider, Refused, Tokens } from "../dash/server/provider.ts";
import type { Db } from "../db/index.ts";

const aad = (reporter: string): string => `reporter_tokens:${reporter}`;
const hashOf = (state: string): string => createHash("sha256").update(state).digest("hex");
const EXPIRY_MARGIN = 60_000;
export const STATE_TTL_MS = 10 * 60_000;

/** Stores the sign-in. A token the reporter had before is queued for revocation (a new sign-in replaces it). */
export async function saveReporter(db: Db, box: TokenBox, reporter: string, githubId: number, login: string, tokens: Tokens, now = Date.now()): Promise<void> {
  const old = await db.get(db.k.selectFrom("reporter_tokens").select(["login", "token_enc"]).where("reporter", "=", reporter));
  if (old) await queueRevoke(db, reporter, old.login, old.token_enc, now);
  await db.run(db.k.insertInto("reporter_tokens")
    .values({ reporter, github_id: githubId, login, token_enc: box.seal(JSON.stringify(tokens), aad(reporter)), version: 1, updated_at: new Date(now).toISOString(), status: "ok" })
    .onConflict((oc) => oc.column("reporter").doUpdateSet((eb) => ({
      github_id: eb.ref("excluded.github_id"), login: eb.ref("excluded.login"), token_enc: eb.ref("excluded.token_enc"),
      version: eb("reporter_tokens.version", "+", 1), updated_at: eb.ref("excluded.updated_at"), status: "ok",
    }))));
}

async function queueRevoke(db: Db, reporter: string, login: string, tokenEnc: string, now: number): Promise<void> {
  await db.run(db.k.insertInto("user_token_revocations").values({ login, token_enc: tokenEnc, queued_at: new Date(now).toISOString(), kind: "token", aad: aad(reporter) }));
}

export async function readReporter(db: Db, box: TokenBox, reporter: string): Promise<{ login: string; tokens: Tokens | null; version: number; status: string } | null> {
  const row = await db.get(db.k.selectFrom("reporter_tokens").select(["login", "token_enc", "version", "status"]).where("reporter", "=", reporter));
  if (!row) return null;
  const plain = box.open(row.token_enc, aad(reporter));
  let tokens: Tokens | null = null;
  try { tokens = plain ? (JSON.parse(plain) as Tokens) : null; } catch { /* unreadable: treated as no token */ }
  return { login: row.login, tokens, version: Number(row.version), status: row.status };
}

/** Marks the row as needing a new sign-in, if it still has `version`. */
export async function failReporter(db: Db, reporter: string, version: number, now = Date.now()): Promise<boolean> {
  return Number((await db.run(db.k.updateTable("reporter_tokens")
    .set((eb) => ({ status: "refresh-failed", version: eb("version", "+", 1), updated_at: new Date(now).toISOString() }))
    .where("reporter", "=", reporter).where("version", "=", version).where("status", "=", "ok"))).changes) > 0;
}

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
  const swapped = Number((await db.run(db.k.updateTable("reporter_tokens")
    .set((eb) => ({ token_enc: box.seal(JSON.stringify(next), aad(reporter)), version: eb("version", "+", 1), updated_at: new Date(now).toISOString(), status: "ok" }))
    .where("reporter", "=", reporter).where("version", "=", row.version).where("status", "=", "ok"))).changes) > 0;
  // A sign-in wrote the row while the refresh ran: its token is the one to use.
  if (!swapped) return obtain(db, box, provider, reporter, now, undefined);
  return { ok: true, access: next.access, login: row.login, version: row.version + 1 };
}

/** A new single-use sign-in state for the reporter; only its hash is stored. `verifier` is the PKCE verifier the callback needs. */
export async function newReporterState(db: Db, reporter: string, now = Date.now()): Promise<string> {
  await db.run(db.k.deleteFrom("reporter_states").where("expires_at", "<", new Date(now).toISOString()));
  const state = randomBytes(24).toString("base64url");
  await db.run(db.k.insertInto("reporter_states")
    .values({ state_hash: hashOf(state), reporter, expires_at: new Date(now + STATE_TTL_MS).toISOString(), verifier: randomBytes(48).toString("base64url") }));
  return state;
}

/** The state's reporter and verifier without using it up (the start route), or null when unknown or expired. */
export async function peekReporterState(db: Db, state: string, now = Date.now()): Promise<{ reporter: string; verifier: string } | null> {
  const r = await db.get(db.k.selectFrom("reporter_states").select(["reporter", "verifier", "expires_at"]).where("state_hash", "=", hashOf(state)));
  return r && Date.parse(r.expires_at) >= now ? { reporter: r.reporter, verifier: r.verifier } : null;
}

/** Uses the state up (the callback). */
export async function takeReporterState(db: Db, state: string, now = Date.now()): Promise<{ reporter: string; verifier: string } | null> {
  const r = await db.get(db.k.deleteFrom("reporter_states").where("state_hash", "=", hashOf(state)).returning(["reporter", "verifier", "expires_at"]));
  return r && Date.parse(r.expires_at) >= now ? { reporter: r.reporter, verifier: r.verifier } : null;
}

/** Removes the reporter's sign-in and filing records and queues the token's revoke. Returns whether one existed. */
export async function forgetReporterRow(db: Db, reporter: string, now = Date.now()): Promise<boolean> {
  await db.run(db.k.deleteFrom("reporter_states").where("reporter", "=", reporter));
  await db.run(db.k.deleteFrom("discord_filed").where("reporter", "=", reporter));
  const row = await db.get(db.k.deleteFrom("reporter_tokens").where("reporter", "=", reporter).returning(["login", "token_enc"]));
  if (!row) return false;
  await queueRevoke(db, reporter, row.login, row.token_enc, now);
  return true;
}
