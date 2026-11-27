// Personal credentials of two kinds. An MCP Connector token: a signed-in user makes one on the Connect page and gives
// it to their own agent, which calls POST /mcp with it as a bearer token and acts as that user. A Task Runner
// credential: the runner makes it itself and a signed-in user approves its device login (src/remote/device-login.ts);
// it claims model calls on /api/remote/*, and with Agent access (can_agent) it also uses /mcp like a connector. Only hashes are stored, and a credential counts only while its login is on
// the access list: the role is read from the list on every call, so a role change applies at once.
import type { Role } from "../types.ts";
import { randomToken, sha256hex } from "../server/crypto.ts";
import { HttpError } from "../server/util.ts";
import type { Db } from "../../db/index.ts";
import * as access from "../../data/access/index.ts";
import * as runners from "../../data/runners/index.ts";

const DAY = 86_400_000;
export const MCP_TOKEN_TTL = 90 * DAY;
/** A connector token that may send commands lasts as long as an operator's dashboard session at most (OPERATOR_SESSION_MAX). */
export const MCP_ANSWER_TOKEN_TTL = 7 * DAY;
/** A Task Runner credential lasts this long after its last use, whatever its scopes. */
export const RUNNER_TOKEN_TTL = 90 * DAY;
/** Per login and kind: five connectors and five runners. */
export const MCP_TOKENS_PER_LOGIN = 5;
export const MCP_TOKEN_PREFIX = "acmcp_";
export const RUNNER_TOKEN_PREFIX = "acrun_";
const LABEL_MAX = 60;

export type TokenKind = "connector" | "runner";
export type McpTokenRow = { id: number; label: string | null; kind: TokenKind; canAnswer: boolean; /** A runner credential may also use /mcp; true for every connector. */ canAgent: boolean; /** Equal to `kind === "runner"`: the credential may claim model calls in the user-local inference mode (src/remote/). */ canRun: boolean; createdAt: string; lastUsedAt: string | null; expiresAt: string };
/**
 * `canAnswer`: the credential may send commands, while `role` may act at the time of the call. `canAgent`: the credential may use /mcp (always for a connector).
 */
export type McpCaller = { tokenId: number; login: string; role: Role; canAnswer: boolean; canAgent: boolean; kind: TokenKind };

type Raw = Pick<access.McpTokenRow, "id" | "label" | "kind" | "can_answer" | "can_agent" | "can_run" | "created_at" | "last_used_at" | "expires_at">;
const toRow = (r: Raw): McpTokenRow =>
  ({ id: Number(r.id), label: r.label, kind: r.kind as TokenKind, canAnswer: Number(r.can_answer) === 1, canAgent: r.kind === "connector" || Number(r.can_agent) === 1, canRun: Number(r.can_run) === 1, createdAt: r.created_at, lastUsedAt: r.last_used_at, expiresAt: r.expires_at });

/** A label as shown: control characters become spaces, trimmed, at most LABEL_MAX characters; null when empty. */
export function cleanLabel(raw: unknown): string | null {
  if (raw !== undefined && raw !== null && typeof raw !== "string") throw new HttpError(400, "label must be a string");
  return (raw ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, LABEL_MAX) || null;
}

/** The login's live tokens of one kind, or of both, newest first. */
export async function listTokens(db: Db, login: string, kind?: TokenKind): Promise<McpTokenRow[]> {
  return (await access.listTokens(db, login, kind)).map(toRow);
}

export type Scopes = { agent: boolean; answer: boolean };

async function insert(db: Db, login: string, hash: string, label: string | null, kind: TokenKind, scopes: Scopes, machine: string | null, helperVersion: string | null = null): Promise<McpTokenRow> {
  const ttl = kind === "runner" ? RUNNER_TOKEN_TTL : scopes.answer ? MCP_ANSWER_TOKEN_TTL : MCP_TOKEN_TTL;
  const row = await db.write(async () => {
    const added = await access.addToken(db, { login, hash, label, kind, scopes: { canAnswer: scopes.answer, canAgent: scopes.agent }, expiresAt: new Date(Date.now() + ttl).toISOString() });
    // The helper row carries the machine the device login reported, so it is known before the first status report.
    if (added && machine) await runners.addHelper(db, { tokenId: Number(added.id), login, machine: JSON.parse(machine) as runners.Machine, helperVersion });
    return added;
  });
  if (!row) throw new HttpError(409, kind === "runner" ? `you have ${MCP_TOKENS_PER_LOGIN} Task Runners; remove one first` : `you have ${MCP_TOKENS_PER_LOGIN} tokens; revoke one first`);
  return toRow(row);
}

/**
 * A new credential for `login`; the plain value is returned once and never stored. Connectors are made on the Connect page;
 * a runner credential made here (server CLI, tests, benchmarks) skips the device login. The caller checks who may make an
 * answering credential. `canAgent` applies to runners only.
 */
export async function createToken(db: Db, login: string, rawLabel: unknown, opts: { kind?: TokenKind; canAnswer?: boolean; canAgent?: boolean } = {}): Promise<{ token: string; row: McpTokenRow }> {
  const kind = opts.kind ?? "connector";
  const token = `${kind === "runner" ? RUNNER_TOKEN_PREFIX : MCP_TOKEN_PREFIX}${randomToken(32)}`;
  return { token, row: await insert(db, login, sha256hex(token), cleanLabel(rawLabel), kind, { agent: opts.canAgent === true, answer: opts.canAnswer === true }, null) };
}

/** The runner credential a device login approved: the runner holds the value, only `hash` arrives here. `machine` is its JSON. */
export async function addRunnerToken(db: Db, login: string, hash: string, label: string | null, machine: string | null, scopes: Scopes, helperVersion: string | null = null): Promise<McpTokenRow> {
  return await insert(db, login, hash, label, "runner", scopes, machine, helperVersion);
}

/** Sets the scopes of one of the login's runners; false when it has no such runner. The caller checks who may grant `answer`. */
export async function setRunnerScopes(db: Db, login: string, id: number, scopes: Scopes): Promise<boolean> {
  return await access.setRunnerScopes(db, login, id, { canAgent: scopes.agent, canAnswer: scopes.answer });
}

/** Revokes one of the login's own credentials of `kind`; false when it has no such credential. */
export async function revokeToken(db: Db, login: string, id: number, kind: TokenKind): Promise<boolean> {
  return await db.write(async () => {
    const gone = await access.revokeToken(db, login, id, kind);
    if (gone) await runners.removeHelpers(db, [id]);
    return gone;
  });
}

/** Ends every token of a login (it left the access list). Their helper rows go with `runners.deleteOrphanHelpers`. */
export async function endTokens(db: Db, login: string): Promise<number> {
  return await access.endTokens(db, [login]);
}

/** Ends a login's answering connector tokens and takes answering from its runners (its role was lowered); the rest stay. */
export const endAnswerTokens = access.endAnswerTokens;

/** Every login's live tokens, for operators on the Access page. */
export async function listAllTokens(db: Db): Promise<(McpTokenRow & { login: string })[]> {
  return (await access.listAllTokens(db)).map((r) => ({ ...toRow(r), login: r.login }));
}

/** Revokes any login's credential by id (an operator's action); its login and kind, or null when there is none. */
export async function revokeAnyToken(db: Db, id: number): Promise<{ login: string; kind: TokenKind } | null> {
  return await db.write(async () => {
    const gone = await access.revokeAnyToken(db, id);
    if (gone) await runners.removeHelpers(db, [id]);
    return gone as { login: string; kind: TokenKind } | null;
  });
}

/**
 * The caller a bearer credential stands for, or null when it is unknown, expired, its prefix does not fit its kind, or its
 * login is off the access list. A runner credential's expiry moves on with each use.
 */
export async function loadToken(db: Db, token: string | undefined): Promise<McpCaller | null> {
  if (!token || token.length > 200) return null;
  const prefix = token.startsWith(RUNNER_TOKEN_PREFIX) ? "runner" : token.startsWith(MCP_TOKEN_PREFIX) ? "connector" : null;
  if (!prefix) return null;
  const row = await access.loadCaller(db, sha256hex(token));
  if (!row || !row.role) return null;
  // Runner credentials from before the split carry the connector prefix.
  if (prefix === "runner" && row.kind !== "runner") return null;
  return { tokenId: Number(row.id), login: row.login, role: row.role, canAnswer: Number(row.can_answer) === 1, canAgent: row.kind === "connector" || Number(row.can_agent) === 1, kind: row.kind as TokenKind };
}

/** Ended credentials, and device logins an hour past their expiry, which their runner has had time to poll for the outcome. */
export async function pruneTokens(db: Db): Promise<void> {
  await access.pruneTokens(db, Date.now());
}
