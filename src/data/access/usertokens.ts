// Per-login GitHub App user tokens, revocations, reseal and reporter tokens (M04 access-b).
//
// The refresh protocol (src/dash/server/token-refresh.ts) calls these writers inside its short write transaction after the token
// endpoint answered; none of them waits on the network. The compare-and-set writers return false when a newer sign-in or refresh
// changed the row first. Values are sealed by the caller; nothing here opens or logs a token.
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import type { Login, ReporterSealed, RevocationRow, Sealed, SealedRow, SealedStore, UserTokenSealed, UserTokenStatus } from "./types.ts";

const statusOf = (s: string): UserTokenStatus => (s === "ok" ? "ok" : "refresh-failed");
const iso = (ms: number): string => new Date(ms).toISOString();

/** Upsert: a first sign-in is version 1, a later one `version + 1`; the row is usable again with no recorded error. */
export async function saveUserToken(db: Db, row: { login: Login; githubId: number; sealed: Sealed; now: string }): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.insertInto("user_tokens")
    .values({ login: row.login, github_id: row.githubId, token_enc: row.sealed, version: 1, updated_at: row.now, status: "ok" })
    .onConflict((oc) => oc.column("login").doUpdateSet((eb) => ({
      github_id: eb.ref("excluded.github_id"), token_enc: eb.ref("excluded.token_enc"), version: eb("user_tokens.version", "+", 1),
      updated_at: eb.ref("excluded.updated_at"), status: "ok", refresh_error: null,
    }))));
}

/** Any status. */
export async function loadUserTokenSealed(db: Db, login: Login): Promise<UserTokenSealed | null> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("user_tokens").select(["token_enc", "version", "status"]).where("login", "=", login));
  return r ? { sealed: r.token_enc as Sealed, version: Number(r.version), status: statusOf(r.status) } : null;
}

/** Set loader for the Access page and the user lane's token wait; keyed by the lower-cased login. */
export async function loadUserTokenStatus(db: Db, logins: Login[]): Promise<Map<string, UserTokenStatus>> {
  const out = new Map<string, UserTokenStatus>();
  if (logins.length === 0) return out;
  const q = queryDb(db);
  for (const r of await q.all(q.k.selectFrom("user_tokens").select(["login", "status"]).where(kx.inList(db, "login", logins, "citext")))) out.set(r.login.toLowerCase(), statusOf(r.status));
  return out;
}

/** Compare-and-set on `version`, whatever the row's status: a row healed from a session's newer token set is usable again. */
export async function swapUserToken(db: Db, login: Login, version: number, sealed: Sealed, now: string): Promise<boolean> {
  const q = queryDb(db);
  return Number((await q.run(q.k.updateTable("user_tokens")
    .set((eb) => ({ token_enc: sealed, version: eb("version", "+", 1), updated_at: now, status: "ok", refresh_error: null }))
    .where("login", "=", login).where("version", "=", version))).changes) > 0;
}

/** Marks the row as needing a new sign-in with the reason (GitHub's error code, never a token value), compare-and-set on `version` and a status still `ok`. */
export async function failUserToken(db: Db, login: Login, version: number, now: string, reason: string): Promise<boolean> {
  const q = queryDb(db);
  return Number((await q.run(q.k.updateTable("user_tokens")
    .set((eb) => ({ status: "refresh-failed", refresh_error: reason, version: eb("version", "+", 1), updated_at: now }))
    .where("login", "=", login).where("version", "=", version).where("status", "=", "ok"))).changes) > 0;
}

/** Deletes the rows returning them, then queues `grant` revocations; one `db.write`. Returns the rows deleted. */
export async function dropUserTokens(db: Db, logins: Login[]): Promise<number> {
  if (logins.length === 0) return 0;
  const q = queryDb(db);
  return await db.write(async () => {
    const rows = await q.all(q.k.deleteFrom("user_tokens").where(kx.inList(db, "login", logins, "citext")).returning(["login", "token_enc"]));
    await queueGrants(db, rows);
    return rows.length;
  });
}

async function queueGrants(db: Db, rows: { login: string; token_enc: string }[]): Promise<void> {
  const q = queryDb(db);
  const at = iso(Date.now());
  for (const b of kx.batches(rows)) await q.run(q.k.insertInto("user_token_revocations").values(b.map((r) => ({ login: r.login, token_enc: r.token_enc, queued_at: at, kind: "grant" }))));
}

/** Deletes every row. Identity switch: the grants are queued for revocation; app removal (`queue: false`): the app is gone, so there is nothing to revoke. */
export async function dropAllUserTokens(db: Db, o: { queue?: boolean } = {}): Promise<number> {
  const q = queryDb(db);
  return await db.write(async () => {
    const rows = await q.all(q.k.deleteFrom("user_tokens").returning(["login", "token_enc"]));
    if (o.queue !== false) await queueGrants(db, rows);
    return rows.length;
  });
}

/** Batched insert of one-token revocations (`aad` names the revoked session). */
export async function queueSessionTokenRevocation(db: Db, rows: { login: Login; sealed: Sealed; aad: string; now: string }[]): Promise<void> {
  const q = queryDb(db);
  for (const b of kx.batches(rows)) await q.run(q.k.insertInto("user_token_revocations").values(b.map((r) => ({ login: r.login, token_enc: r.sealed, queued_at: r.now, kind: "token", aad: r.aad }))));
}

/** Queued revocations, oldest first; `freshOnly`: those not tried yet. */
export async function loadRevocations(db: Db, o: { freshOnly: boolean }): Promise<RevocationRow[]> {
  const q = queryDb(db);
  return await q.all(q.k.selectFrom("user_token_revocations").select(kx.cols("user_token_revocations")).$if(o.freshOnly, (s) => s.where("attempts", "=", 0)).orderBy("id"));
}

/** `LIMIT 1` probe run on every request. */
export async function hasFreshRevocation(db: Db): Promise<boolean> {
  const q = queryDb(db);
  return !!await q.get(q.k.selectFrom("user_token_revocations").select("id").where("attempts", "=", 0).limit(1));
}

/** Compare-and-set on `attempts`: of several sweeps that read the same row, one wins (an effect guard). */
export async function claimRevocation(db: Db, id: number, attempts: number): Promise<boolean> {
  const q = queryDb(db);
  return Number((await q.run(q.k.updateTable("user_token_revocations").set((eb) => ({ attempts: eb("attempts", "+", 1) })).where("id", "=", id).where("attempts", "=", attempts))).changes) === 1;
}

/** Batched delete. */
export async function finishRevocations(db: Db, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const q = queryDb(db);
  await q.run(q.k.deleteFrom("user_token_revocations").where(kx.inList(db, "id", ids, "bigint")));
}

/** Sealed token sets of a login's sessions (`shareRefresh`). */
export async function loadSessionSealedOf(db: Db, login: Login): Promise<{ idHash: string; sealed: Sealed }[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("sessions").select(["id_hash", "token_enc"]).where("login", "=", login).where("token_enc", "is not", null));
  return rows.map((r) => ({ idHash: r.id_hash, sealed: r.token_enc as Sealed }));
}

/** One compare-and-set `UPDATE ... FROM` for many sessions; only a row still holding `old` changes. Call inside the refresh's write. */
export async function swapSessionTokens(db: Db, rows: { idHash: string; old: Sealed; sealed: Sealed }[]): Promise<number> {
  return await swapBy(db, "sessions", "id_hash", "text", rows.map((r) => ({ id: r.idHash, old: r.old, sealed: r.sealed })));
}

/** Deletes the login's row only when it is still at `version` (the vault's sweep, when the row holds the revoked sign-in's token set). */
export async function deleteUserTokenIf(db: Db, login: Login, version: number): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.deleteFrom("user_tokens").where("login", "=", login).where("version", "=", version));
}

const STORE_KEYS = { sessions: ["id_hash", "text"], user_tokens: ["login", "citext"], user_token_revocations: ["id", "bigint"], reporter_tokens: ["reporter", "text"] } as const;

async function swapBy(db: Db, table: SealedStore, idCol: string, idType: "text" | "citext" | "bigint", rows: { id: string | number; old: string; sealed: string }[]): Promise<number> {
  if (rows.length === 0) return 0;
  const k = queryDb(db).k as any;
  let changed = 0;
  for (const b of kx.chunks(rows)) {
    changed += Number((await queryDb(db).run(k.updateTable(table).from(kx.valuesTable(db, b, { id: idType, old: "text", sealed: "text" }, "v"))
      .set((eb: any) => ({ token_enc: eb.ref("v.sealed") }))
      .where((eb: any) => eb.and([eb(`${table}.${idCol}`, "=", eb.ref("v.id")), eb(`${table}.token_enc`, "=", eb.ref("v.old"))])))).changes);
  }
  return changed;
}

/** Rows of the four sealed stores in one wave. */
export async function listSealedRows(db: Db): Promise<SealedRow[]> {
  const q = queryDb(db);
  const [sessions, users, revocations, reporters] = await db.together(() => Promise.all([
    q.all(q.k.selectFrom("sessions").select(["id_hash", "token_enc"]).where("token_enc", "is not", null)),
    q.all(q.k.selectFrom("user_tokens").select(["login", "token_enc"])),
    q.all(q.k.selectFrom("user_token_revocations").select(["id", "token_enc", "login", "aad"])),
    q.all(q.k.selectFrom("reporter_tokens").select(["reporter", "token_enc"])),
  ]));
  return [
    ...sessions.map((r): SealedRow => ({ store: "sessions", id: r.id_hash, sealed: r.token_enc as Sealed, aadFields: { id_hash: r.id_hash } })),
    ...users.map((r): SealedRow => ({ store: "user_tokens", id: r.login, sealed: r.token_enc as Sealed, aadFields: { login: r.login } })),
    ...revocations.map((r): SealedRow => ({ store: "user_token_revocations", id: Number(r.id), sealed: r.token_enc as Sealed, aadFields: { login: r.login, aad: r.aad } })),
    ...reporters.map((r): SealedRow => ({ store: "reporter_tokens", id: r.reporter, sealed: r.token_enc as Sealed, aadFields: { reporter: r.reporter } })),
  ];
}

/** One compare-and-set update per store; one `db.write`. */
export async function swapSealedRows(db: Db, rows: { store: SealedStore; id: number | string; old: Sealed; sealed: Sealed }[]): Promise<Record<SealedStore, number>> {
  const out: Record<SealedStore, number> = { sessions: 0, user_tokens: 0, user_token_revocations: 0, reporter_tokens: 0 };
  if (rows.length === 0) return out;
  await db.write(async () => {
    for (const store of Object.keys(STORE_KEYS) as SealedStore[]) {
      const [col, type] = STORE_KEYS[store];
      out[store] = await swapBy(db, store, col, type, rows.filter((r) => r.store === store).map((r) => ({ id: r.id, old: r.old, sealed: r.sealed })));
    }
  });
  return out;
}

/** Upsert that queues the replaced token's revocation; one `db.write`. */
export async function saveReporter(db: Db, row: { reporter: string; githubId: number; login: Login; sealed: Sealed; now: string }): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    const old = await q.get(q.k.selectFrom("reporter_tokens").select(["login", "token_enc"]).where("reporter", "=", row.reporter));
    if (old) await q.run(q.k.insertInto("user_token_revocations").values({ login: old.login, token_enc: old.token_enc, queued_at: row.now, kind: "token", aad: `reporter_tokens:${row.reporter}` }));
    await q.run(q.k.insertInto("reporter_tokens")
      .values({ reporter: row.reporter, github_id: row.githubId, login: row.login, token_enc: row.sealed, version: 1, updated_at: row.now, status: "ok" })
      .onConflict((oc) => oc.column("reporter").doUpdateSet((eb) => ({
        github_id: eb.ref("excluded.github_id"), login: eb.ref("excluded.login"), token_enc: eb.ref("excluded.token_enc"),
        version: eb("reporter_tokens.version", "+", 1), updated_at: eb.ref("excluded.updated_at"), status: "ok",
      }))));
  });
}

/** One reporter token. */
export async function loadReporterSealed(db: Db, reporter: string): Promise<ReporterSealed | null> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("reporter_tokens").select(["login", "token_enc", "version", "status"]).where("reporter", "=", reporter));
  return r ? { login: r.login, sealed: r.token_enc as Sealed, version: Number(r.version), status: statusOf(r.status) } : null;
}

/** Compare-and-set on `version` and a status still `ok`: a sign-in that wrote the row meanwhile wins. */
export async function swapReporter(db: Db, reporter: string, version: number, sealed: Sealed, now: string): Promise<boolean> {
  const q = queryDb(db);
  return Number((await q.run(q.k.updateTable("reporter_tokens")
    .set((eb) => ({ token_enc: sealed, version: eb("version", "+", 1), updated_at: now, status: "ok" }))
    .where("reporter", "=", reporter).where("version", "=", version).where("status", "=", "ok"))).changes) > 0;
}

/** Marks a refresh failure, compare-and-set on `version` and a status still `ok`. */
export async function failReporter(db: Db, reporter: string, version: number, now: string): Promise<boolean> {
  const q = queryDb(db);
  return Number((await q.run(q.k.updateTable("reporter_tokens")
    .set((eb) => ({ status: "refresh-failed", version: eb("version", "+", 1), updated_at: now }))
    .where("reporter", "=", reporter).where("version", "=", version).where("status", "=", "ok"))).changes) > 0;
}

/** Insert, also deleting expired rows; one `db.write`. */
export async function addReporterState(db: Db, row: { stateHash: string; reporter: string; verifier: string; expiresAt: string }, o: { now: string }): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    await q.run(q.k.deleteFrom("reporter_states").where("expires_at", "<", o.now));
    await q.run(q.k.insertInto("reporter_states").values({ state_hash: row.stateHash, reporter: row.reporter, expires_at: row.expiresAt, verifier: row.verifier }));
  });
}

/** Reads a state without taking it; null when unknown or expired at `now`. */
export async function peekReporterState(db: Db, stateHash: string, now: string): Promise<{ reporter: string; verifier: string } | null> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("reporter_states").select(["reporter", "verifier"]).where("state_hash", "=", stateHash).where("expires_at", ">=", now));
  return r ?? null;
}

/** Delete returning; null when unknown or expired at `now` (an expired row is still deleted). */
export async function takeReporterState(db: Db, stateHash: string, now: string): Promise<{ reporter: string; verifier: string } | null> {
  const q = queryDb(db);
  const r = await q.get(q.k.deleteFrom("reporter_states").where("state_hash", "=", stateHash).returning(["reporter", "verifier", "expires_at"]));
  return r && r.expires_at >= now ? { reporter: r.reporter, verifier: r.verifier } : null;
}

/** Deletes states and token, queues the revocation; one `db.write`. The caller also clears the reporter's filed records (discord module) in the same write. */
export async function forgetReporterTokens(db: Db, reporter: string, now: string): Promise<boolean> {
  const q = queryDb(db);
  return await db.write(async () => {
    await q.run(q.k.deleteFrom("reporter_states").where("reporter", "=", reporter));
    const row = await q.get(q.k.deleteFrom("reporter_tokens").where("reporter", "=", reporter).returning(["login", "token_enc"]));
    if (!row) return false;
    await q.run(q.k.insertInto("user_token_revocations").values({ login: row.login, token_enc: row.token_enc, queued_at: now, kind: "token", aad: `reporter_tokens:${reporter}` }));
    return true;
  });
}
