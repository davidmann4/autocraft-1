// The user lane: a merge or a close that carries out a person's command is made as that person, with their GitHub App
// user token (src/github/vault.ts), never as the box account or the app. Every other write of the same command, the comment
// before a close included, is the app's and needs no lane. The lane applies while the GitHub identity is `app`; under `box`
// nothing here runs and the box account writes as before.
//
// A person action (`workflow_actions`: a close or a merge made as someone) whose person has no usable token, or no write access
// on the repo, does not fail: it waits (state waiting-token / waiting-permission, with a plain reason) and runs again after that
// person signs in or authorizes again, or when someone presses Retry.
import { statSync } from "node:fs";
import { AppError, call, GITHUB_API } from "./app.ts";
import { githubIdentity } from "./identity.ts";
import { openVault, type Vault } from "./vault.ts";
import { envVar } from "../env.ts";
import { appChildEnv } from "./install-token.ts";
import { exec as defaultExec, type Exec } from "../fixup/git.ts";
import { Client, GithubError, Transient, type Querier } from "../mirror.ts";
import { ACTION_WAITS } from "../core/may.ts";
import { slugOf } from "../owners.ts";
import { loadAccess, loadUserTokenStatus } from "../data/access/index.ts";
import { queueActions, retryActions, saveActions, type ActionState, type NewAction, type WorkflowAction } from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";

export type ExecState = ActionState;
export { ACTION_WAITS as WAITING };

export const SIGN_IN_REASON = "Sign in to let AutoCraft finish this as you";
export const noWriteReason = (repo: string): string => `You have no write access to ${slugOf(repo)}`;

/** Sets the state shown on the action. The module writes nothing when it is already that, so the planner is not woken for nothing. */
export async function setExecState(db: Db, id: number, state: ActionState, reason: string | null = null, at = new Date().toISOString()): Promise<void> {
  await saveActions(db, [{ id, state, reason, at }]);
}

/**
 * Queues person actions: pending, or waiting-token when the app identity is on and the person has no stored token set (a database
 * read only: the network checks happen when the write runs). Returns the action ids by `repo#number:kind`.
 */
export async function queueLaneActions(db: Db, rows: NewAction[]): Promise<Map<string, number>> {
  if (!rows.length) return new Map();
  const app = await githubIdentity(db) === "app";
  const tokens = app ? await loadUserTokenStatus(db, [...new Set(rows.map((r) => r.by))]) : new Map<string, string>();
  return await queueActions(db, rows.map((r) => ({ ...r, state: r.state ?? (!app || tokens.get(r.by.toLowerCase()) === "ok" ? "pending" : "waiting-token") })));
}

/** Puts the person's waiting actions back to pending so the stages take them up again. Returns how many changed. */
export async function retryWaiting(db: Db, login: string): Promise<number> {
  return await retryActions(db, { login });
}

/** A waiting or failed action starts again, its tries from zero. */
export async function retryAction(db: Db, id: number): Promise<boolean> {
  return await retryActions(db, { ids: [id] }) > 0;
}

// ---- the lane ----------------------------------------------------------------------

/** What a write made as a user needs: the user's name for the audit row, and the transports that carry the token. */
export type Lane = {
  login: string;
  /** The whole environment of the child: the user's token as GH_TOKEN, and none of the box's own tokens. */
  env: Record<string, string>;
  querier: Querier;
  exec: Exec;
};

export type Permission = "write" | "none" | "rejected";

export type LaneDeps = {
  vault: Pick<Vault, "userToken"> | null;
  /** The user's permission on the repo, read with the user's token. Throws when GitHub cannot answer. */
  permission?: (token: string, repo: string) => Promise<Permission>;
  /** Tests replace the transports. */
  transports?: (env: Record<string, string>) => { querier: Querier; exec: Exec };
};

export type Waiting = { state: "waiting-token" | "waiting-permission"; reason: string };
/** `transient`: GitHub or the token refresh could not answer now; nothing is recorded and the next run tries again. */
export type LaneResult = { lane: Lane } | Waiting | { transient: string };

/** The repo's permission for the token, from GitHub's `permissions` field of the repository. */
export async function githubPermission(token: string, repo: string, apiBase = GITHUB_API): Promise<Permission> {
  try {
    const r = (await call(apiBase, `/repos/${slugOf(repo)}`, token)) as { permissions?: { admin?: boolean; maintain?: boolean; push?: boolean } };
    const p = r.permissions;
    return p?.push || p?.maintain || p?.admin ? "write" : "none";
  } catch (e) {
    if (e instanceof AppError) {
      if (e.status === 401) return "rejected";
      // A rate limit answers 403 or 429 too: GitHub could not answer now, which is not "no access".
      if (!e.rateLimited && (e.status === 403 || e.status === 404)) return "none";
    }
    throw e;
  }
}

const memo = new WeakMap<Db, { key: string; deps: LaneDeps }>();
/**
 * The vault of the secrets file (null without a registered app) and GitHub's own permission read. A vault is kept per
 * database connection while the secrets file is the same one (path, mtime, size); when none could be opened nothing is kept.
 */
export async function defaultLaneDeps(db: Db): Promise<LaneDeps> {
  const key = secretsKey();
  const m = memo.get(db);
  if (m && m.key === key) return m.deps;
  let vault: Vault | null = null;
  try { vault = await openVault(db); } catch { /* no readable secrets: no token can be had */ }
  const deps: LaneDeps = { vault };
  if (vault) memo.set(db, { key, deps }); else memo.delete(db);
  return deps;
}

function secretsKey(): string {
  const f = envVar("SECRETS_FILE");
  if (!f) return "";
  try { const s = statSync(f); return `${f}:${s.mtimeMs}:${s.size}`; } catch { return f; }
}

export function laneOf(deps: LaneDeps, login: string, token: string): Lane {
  const env = appChildEnv(token);
  const t = deps.transports?.(env);
  return {
    login, env,
    querier: t?.querier ?? new Client(1000, env),
    exec: t?.exec ?? ((cmd, args, opts) => defaultExec(cmd, args, { ...opts, env: { ...env, ...opts?.env }, replaceEnv: true })),
  };
}

/** A usable token for the login and write access on every repo, or the reason it waits. */
export async function resolveLane(deps: LaneDeps, login: string, repos: string[]): Promise<LaneResult> {
  if (!deps.vault) return { state: "waiting-token", reason: SIGN_IN_REASON };
  const permission = deps.permission ?? githubPermission;
  let t = await deps.vault.userToken(login);
  for (let attempt = 0; ; attempt++) {
    if (!t.ok) return t.needsSignIn ? { state: "waiting-token", reason: SIGN_IN_REASON } : { transient: "the user token could not be refreshed now" };
    let rejected = false;
    for (const repo of repos) {
      let p: Permission;
      try {
        p = await permission(t.access, repo);
      } catch (e) {
        return { transient: String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 200) };
      }
      if (p === "none") return { state: "waiting-permission", reason: noWriteReason(repo) };
      if (p === "rejected") { rejected = true; break; }
    }
    if (!rejected) return { lane: laneOf(deps, login, t.access) };
    // GitHub refused the access token as expired or revoked: one refresh, then the person has to sign in again.
    if (attempt > 0) return { state: "waiting-token", reason: SIGN_IN_REASON };
    t = await deps.vault.userToken(login, t.access);
  }
}

const NOT_APP_REASON = "This command was given by a maintainer and can only be carried out as that person: the repo does not use the app identity";

/**
 * The lane for the person an action is made as, or null when every repo is on the box account: the caller then uses its own
 * transports and nothing changes. Only the repos on `app` are checked. A waiting action stays put until its person signs in or
 * someone retries it: no network call per run.
 */
export async function laneForAction(db: Db, deps: LaneDeps | undefined, a: Pick<WorkflowAction, "by" | "state" | "reason">, repos: string[]): Promise<LaneResult | null> {
  const app = (await githubIdentity(db) === "app" ? repos : []);
  // A maintainer's command is never carried out by the box account: a repo off the app identity refuses the write.
  if (app.length < repos.length && (await loadAccess(db, [a.by])).get(a.by.toLowerCase())?.role === "maintainer") return { state: "waiting-permission", reason: NOT_APP_REASON };
  if (!app.length) return null;
  if (a.state === "waiting-token" || a.state === "waiting-permission") return { state: a.state, reason: a.reason ?? SIGN_IN_REASON };
  return resolveLane(deps ?? await defaultLaneDeps(db), a.by, app);
}

/** The lane for an operator acting right now (a conversation card), or null when every repo is on the box account. */
export async function laneForOperator(db: Db, deps: LaneDeps | undefined, login: string, repos: string[]): Promise<LaneResult | null> {
  const app = (await githubIdentity(db) === "app" ? repos : []);
  return app.length ? resolveLane(deps ?? await defaultLaneDeps(db), login, app) : null;
}

/** An action that waits for its person's token or access: the stages leave it out of their work until it is retried. */
export const isWaiting = (a: Pick<WorkflowAction, "state"> | null | undefined): boolean => !!a && ACTION_WAITS.includes(a.state);

/**
 * How a failed write as a user is classified, from the HTTP status (a GitHub error's, or gh's own "(HTTP 403)" line in
 * a command's output) and the GraphQL error type, never from other numbers or words in the text. 401 means the token is
 * no good; 403 and 404 (FORBIDDEN, NOT_FOUND) mean no access. A rate limit and a transient failure are "transient":
 * nothing is recorded and the next run tries again. Anything else, a refusal included, is null.
 */
export function authFailure(e: unknown): "waiting-token" | "waiting-permission" | "transient" | null {
  if (e instanceof Transient) return "transient";
  const message = String((e as Error)?.message ?? e);
  if (e instanceof AppError && e.rateLimited) return "transient";
  const status = e instanceof GithubError || e instanceof AppError ? e.status : httpStatusOfLine(message);
  const type = e instanceof GithubError ? e.type : null;
  if (status === 429 || (status === 403 && /rate limit/i.test(message))) return "transient";
  if (status === 401 || type === "UNAUTHENTICATED") return "waiting-token";
  if (status === 403 || status === 404 || type === "FORBIDDEN" || type === "NOT_FOUND") return "waiting-permission";
  return null;
}

const httpStatusOfLine = (text: string): number => Number(/(?:^|[\s(])HTTP (\d{3})\b/.exec(text)?.[1] ?? 0);
