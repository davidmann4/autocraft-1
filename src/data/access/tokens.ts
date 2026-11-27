// MCP connector and Task Runner credentials (M04 access-b).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import type { Login, LoginState, McpCaller, McpTokenRow, NewRunnerLogin, NewToken, Role, RunnerLoginRow, RunnerTokenRow, TokenScopes } from "./types.ts";

const DAY = 86_400_000;
const TOUCH_EVERY = 60_000;
/** A Task Runner credential lasts this long after its last use. */
const RUNNER_TOKEN_TTL = 90 * DAY;
/** Per login and kind. */
export const TOKENS_PER_LOGIN = 5;
/** Runner logins stay this long past their expiry, for the runner to read the outcome. */
const LOGIN_KEEP_MS = 3_600_000;

/** `addToken` found the login already at its limit of live tokens of that kind. */
export class TokenLimitError extends Error {
  readonly kind: string;
  constructor(kind: string) {
    super(`a login holds at most ${TOKENS_PER_LOGIN} live tokens of kind ${kind}`);
    this.kind = kind;
  }
}

const TOKEN_COLS = ["id", "login", "label", "kind", "can_answer", "can_agent", "can_run", "created_at", "last_used_at", "expires_at"] as const;
const iso = (ms: number): string => new Date(ms).toISOString();

/** A person's live tokens, newest first. */
export async function listTokens(db: Db, login: Login, kind?: string): Promise<McpTokenRow[]> {
  const q = queryDb(db);
  return await q.all(q.k.selectFrom("mcp_tokens").select(TOKEN_COLS).where("login", "=", login).where("expires_at", ">", iso(Date.now()))
    .$if(!!kind, (s) => s.where("kind", "=", kind!)).orderBy("created_at", "desc").orderBy("id", "desc"));
}

/** Every live token, for the Access page. */
export async function listAllTokens(db: Db): Promise<(McpTokenRow & { login: string })[]> {
  const q = queryDb(db);
  return await q.all(q.k.selectFrom("mcp_tokens").select(TOKEN_COLS).where("expires_at", ">", iso(Date.now()))
    .orderBy(kx.nocase(db, "login")).orderBy("created_at", "desc").orderBy("id", "desc"));
}

/** Guarded insert (at most 5 live tokens per login and kind) in one statement; null is the 409. */
export async function addToken(db: Db, row: NewToken): Promise<McpTokenRow | null> {
  const q = queryDb(db);
  const k = q.k as any;
  const now = iso(Date.now());
  const runner = row.kind === "runner";
  const values = {
    login: row.login, token_hash: row.hash, label: row.label, kind: row.kind, can_answer: row.scopes.canAnswer ? 1 : 0,
    can_agent: runner && row.scopes.canAgent ? 1 : 0, can_run: runner ? 1 : 0, created_at: now, expires_at: row.expiresAt,
  };
  const types = { login: "citext", token_hash: "text", label: "text", kind: "text", can_answer: "bigint", can_agent: "bigint", can_run: "bigint", created_at: "text", expires_at: "text" } as const;
  const names = Object.keys(types);
  const inserted = await q.get(k.insertInto("mcp_tokens").columns(names)
    .expression((eb: any) => eb.selectFrom(kx.valuesTable(db, [values], types, "v")).select(names.map((n) => `v.${n}`))
      .where((w: any) => w(w.selectFrom("mcp_tokens as t").select(w.fn.countAll().as("n"))
        .where("t.login", "=", row.login).where("t.kind", "=", row.kind).where("t.expires_at", ">", now), "<", TOKENS_PER_LOGIN)))
    .returning(TOKEN_COLS)) as McpTokenRow | undefined;
  return inserted ?? null;
}

/** Updates the scopes of a runner token. */
export async function setRunnerScopes(db: Db, login: Login, id: number, scopes: TokenScopes): Promise<boolean> {
  const q = queryDb(db);
  return Number((await q.run(q.k.updateTable("mcp_tokens").set({ can_agent: scopes.canAgent ? 1 : 0, can_answer: scopes.canAnswer ? 1 : 0 })
    .where("id", "=", id).where("login", "=", login).where("kind", "=", "runner").where("expires_at", ">", iso(Date.now())))).changes) === 1;
}

/** One live runner token of the login. */
export async function loadRunnerTokenOf(db: Db, login: Login, id: number): Promise<{ canAnswer: boolean } | null> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("mcp_tokens").select("can_answer").where("id", "=", id).where("login", "=", login).where("kind", "=", "runner").where("expires_at", ">", iso(Date.now())));
  return r ? { canAnswer: Number(r.can_answer) === 1 } : null;
}

/** A person's live runner tokens, newest first. */
export async function loadRunnerTokensOf(db: Db, login: Login): Promise<RunnerTokenRow[]> {
  const q = queryDb(db);
  return await q.all(q.k.selectFrom("mcp_tokens").select(["id", "label", "created_at", "expires_at", "can_agent", "can_answer"])
    .where("login", "=", login).where("kind", "=", "runner").where("expires_at", ">", iso(Date.now())).orderBy("created_at", "desc").orderBy("id", "desc"));
}

/** Deletes one of the login's own tokens of `kind`. */
export async function revokeToken(db: Db, login: Login, id: number, kind: string): Promise<boolean> {
  const q = queryDb(db);
  return Number((await q.run(q.k.deleteFrom("mcp_tokens").where("id", "=", id).where("login", "=", login).where("kind", "=", kind))).changes) === 1;
}

/** Admin revoke: delete returning. */
export async function revokeAnyToken(db: Db, id: number): Promise<{ login: string; kind: string } | null> {
  const q = queryDb(db);
  return (await q.get(q.k.deleteFrom("mcp_tokens").where("id", "=", id).returning(["login", "kind"]))) ?? null;
}

/** Batched delete: every token of the logins. */
export async function endTokens(db: Db, logins: Login[]): Promise<number> {
  if (logins.length === 0) return 0;
  const q = queryDb(db);
  return Number((await q.run(q.k.deleteFrom("mcp_tokens").where(kx.inList(db, "login", logins, "citext")))).changes);
}

/** Deletes answer tokens and clears the answer scope of the login's runners; one `db.write`. */
export async function endAnswerTokens(db: Db, login: Login): Promise<number> {
  const q = queryDb(db);
  return await db.write(async () =>
    Number((await q.run(q.k.deleteFrom("mcp_tokens").where("login", "=", login).where("can_answer", "=", 1).where("kind", "=", "connector"))).changes)
    + Number((await q.run(q.k.updateTable("mcp_tokens").set({ can_answer: 0 }).where("login", "=", login).where("can_answer", "=", 1).where("kind", "=", "runner"))).changes));
}

/** Joins `access` for the role; moves `last_used_at`, and a runner's expiry, forward at most once a minute. */
export async function loadCaller(db: Db, hash: string): Promise<McpCaller | null> {
  const q = queryDb(db);
  const nowMs = Date.now();
  const row = await q.get(q.k.selectFrom("mcp_tokens as t").innerJoin("access as a", "a.login", "t.login")
    .select([...TOKEN_COLS.map((c) => `t.${c}` as const), "a.role"]).where("t.token_hash", "=", hash).where("t.expires_at", ">", iso(nowMs)));
  if (!row) return null;
  if (!row.last_used_at || nowMs - Date.parse(row.last_used_at) > TOUCH_EVERY) {
    await q.run(q.k.updateTable("mcp_tokens")
      .set(row.kind === "runner" ? { last_used_at: iso(nowMs), expires_at: iso(nowMs + RUNNER_TOKEN_TTL) } : { last_used_at: iso(nowMs) })
      .where("id", "=", row.id));
  }
  return { ...row, role: row.role as Role };
}

/** Deletes expired tokens and runner logins an hour past expiry; one `db.write`. */
export async function pruneTokens(db: Db, now: number): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    await q.run(q.k.deleteFrom("mcp_tokens").where("expires_at", "<=", iso(now)));
    await q.run(q.k.deleteFrom("runner_logins").where("expires_at", "<=", now - LOGIN_KEEP_MS));
  });
}

/** Addresses of the pending runner logins (null where none was recorded); their number is the total pending. */
export async function listPendingLoginIps(db: Db, nowMs: number): Promise<(string | null)[]> {
  const q = queryDb(db);
  return (await q.all(q.k.selectFrom("runner_logins").select("ip").where("state", "=", "pending").where("expires_at", ">", nowMs))).map((r) => r.ip);
}

/** Whether a hash is in `runner_logins` or `mcp_tokens`. */
export async function credentialInUse(db: Db, hash: string): Promise<boolean> {
  const q = queryDb(db);
  return !!await q.get(q.k.selectFrom("runner_logins").select((eb) => eb.lit(1).as("one")).where("secret_hash", "=", hash)
    .unionAll(q.k.selectFrom("mcp_tokens").select((eb) => eb.lit(1).as("one")).where("token_hash", "=", hash)));
}

/** Insert on conflict do nothing. */
export async function addRunnerLogin(db: Db, row: NewRunnerLogin): Promise<"added" | "code-taken"> {
  const q = queryDb(db);
  return await q.get(q.k.insertInto("runner_logins").values(row).onConflict((oc) => oc.column("user_code").doNothing()).returning("id")) ? "added" : "code-taken";
}

/** Reads the login; moves an expired one to `expired`. A login pruned an hour after expiry still answers `approved` while its credential lives. */
export async function pollRunnerLogin(db: Db, hash: string, nowMs: number): Promise<LoginState | null> {
  const q = queryDb(db);
  const row = await q.get(q.k.selectFrom("runner_logins").select(["id", "state", "expires_at"]).where("secret_hash", "=", hash));
  if (!row) {
    return await q.get(q.k.selectFrom("mcp_tokens").select((eb) => eb.lit(1).as("one")).where("token_hash", "=", hash).where("kind", "=", "runner").where("expires_at", ">", iso(nowMs)))
      ? { state: "approved" } : null;
  }
  if (row.state === "pending" && Number(row.expires_at) <= nowMs) {
    await q.run(q.k.updateTable("runner_logins").set({ state: "expired" }).where("id", "=", row.id).where("state", "=", "pending"));
    return { state: "expired" };
  }
  return { state: row.state };
}

const pending = (db: Db, code: string, nowMs: number) => {
  const q = queryDb(db);
  return q.k.selectFrom("runner_logins").select(kx.cols("runner_logins")).where("user_code", "=", code).where("state", "=", "pending").where("expires_at", ">", nowMs);
};

/** The pending login of a code. */
export async function loadPendingLogin(db: Db, code: string, nowMs: number): Promise<RunnerLoginRow | null> {
  return (await queryDb(db).get(pending(db, code, nowMs))) ?? null;
}

/**
 * Atomic: read, the caller's pure address check, guarded token insert, mark approved; one `db.write`. `o.label` null keeps the runner's own.
 * Throws `TokenLimitError` (nothing written) when the approver already holds the most runners.
 */
export async function approveRunnerLogin(db: Db, approver: string, code: string, o: { label: string | null; scopes: TokenScopes; nowMs: number; checkAddress: (row: RunnerLoginRow) => void }): Promise<{ token: McpTokenRow; machine: string | null; ip: string | null } | null> {
  const q = queryDb(db);
  return await db.write(async () => {
    const r = await loadPendingLogin(db, code, o.nowMs);
    if (!r) return null;
    o.checkAddress(r);
    const token = await addToken(db, { login: approver, hash: r.secret_hash, label: o.label ?? r.label, kind: "runner", scopes: o.scopes, expiresAt: iso(o.nowMs + RUNNER_TOKEN_TTL) });
    if (!token) throw new TokenLimitError("runner");
    await q.run(q.k.updateTable("runner_logins").set({ state: "approved", login: approver, token_id: token.id }).where("id", "=", r.id));
    return { token, machine: r.machine, ip: r.ip };
  });
}

/** `UPDATE ... WHERE state = 'pending' ... RETURNING`. */
export async function denyRunnerLogin(db: Db, approver: string, code: string, nowMs: number): Promise<{ label: string | null; machine: string | null; ip: string | null } | null> {
  const q = queryDb(db);
  return (await q.get(q.k.updateTable("runner_logins").set({ state: "denied", login: approver })
    .where("user_code", "=", code).where("state", "=", "pending").where("expires_at", ">", nowMs).returning(["label", "machine", "ip"]))) ?? null;
}
