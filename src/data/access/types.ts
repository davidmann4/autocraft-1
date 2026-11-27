import type { Selectable } from "kysely";
import type { DB } from "../../db/types.ts";

export type Role = "operator" | "maintainer" | "viewer";
/** Compared without letter case; keyed maps use the lower-cased login. */
export type Login = string;
/** `${lowerLogin}\n${repo}` */
export type PermKey = string;

/** A value sealed by `TokenBox`; loaders never open it, so no secret reaches a log or read model. */
export type Sealed = string & { readonly __sealed: true };

export type AccessRow = Omit<Selectable<DB["access"]>, "role"> & { role: Role };
export type PermRow = Selectable<DB["repo_permissions"]>;
export type PermEntry = { permission: string; checkedAt: string };
export type RemovedSummary = { role: string | null; sessions: number; tokens: number; userTokens: number; links: number };

export type ActFacts = { login: string | null; role: Role | null; githubId: number | null; perm: PermEntry | null };
export type ActRefusal = "no-login" | "no-role" | "no-write" | "box-identity";
export type ActVerdict =
  | { ok: true; role: "operator" | "maintainer"; basis: "live" | "cached" }
  | { ok: false; why: ActRefusal | "stale" };
export type ActIdentity = "app" | "box";
/** Whether a person's earlier approval or start still counts; "unknown" until GitHub answers on their write access. */
export type Standing = "yes" | "no" | "unknown";

/** `rowid` is how the Access page addresses a session; it stays inside access and the dashboard. */
export type SessionRow = Selectable<DB["sessions"]> & { rowid: number; role: Role | null };
export type AdminSession = SessionRow;
export type NewSession = { idHash: string; login: string; csrf: string; sealedTokens: Sealed | null; now: string; expiresAt: string; userAgent: string | null };
export type OauthState = Selectable<DB["oauth_states"]>;
export type NewOauthState = { state: string; verifier: string; returnTo: string | null; identity: string; createdAt: string };

/** The columns loaders return: no hash, and none of the helper columns that moved to `runners.remote_helpers`. */
export type McpTokenRow = Pick<Selectable<DB["mcp_tokens"]>, "id" | "login" | "label" | "kind" | "can_answer" | "can_agent" | "can_run" | "created_at" | "last_used_at" | "expires_at">;
export type TokenScopes = { canAnswer?: boolean; canAgent?: boolean; canRun?: boolean };
export type NewToken = { login: string; hash: string; label: string | null; kind: string; scopes: TokenScopes; expiresAt: string };
export type RunnerTokenRow = Pick<McpTokenRow, "id" | "label" | "created_at" | "expires_at" | "can_agent" | "can_answer">;
export type McpCaller = McpTokenRow & { role: Role | null };
export type RunnerLoginRow = Selectable<DB["runner_logins"]>;
export type NewRunnerLogin = Pick<RunnerLoginRow, "user_code" | "secret_hash" | "label" | "machine" | "ip" | "helper_version" | "created_at" | "expires_at" | "want_agent" | "want_answer">;
export type LoginState = { state: string; token?: string };

export type UserTokenStatus = "ok" | "refresh-failed";
export type UserTokenSealed = { sealed: Sealed; version: number; status: UserTokenStatus };
export type RevocationRow = Selectable<DB["user_token_revocations"]>;
export type SealedStore = "sessions" | "user_tokens" | "user_token_revocations" | "reporter_tokens";
export type SealedRow = { store: SealedStore; id: number | string; sealed: Sealed; aadFields: Record<string, string | number | null> };
export type ReporterSealed = { login: string; sealed: Sealed; version: number; status: UserTokenStatus };
export type AppSealed = { appId: number; slug: string; sealed: Sealed };
export type AppState = Selectable<DB["github_app_states"]>;
export type SetupLink = Selectable<DB["github_setup_links"]>;
export type NewSetupLink = Pick<SetupLink, "id" | "org" | "created_by" | "hash" | "created_at" | "expires_at">;
export type AllowedOwner = Selectable<DB["app_allowed_owners"]>;
export type LinkRow = Selectable<DB["discord_links"]>;
export type OverrideRow = Selectable<DB["whitelist_overrides"]>;
export type Override = { login: string; status: string; githubId: number | null; note: string | null; by: string | null; at: string | null };
export type AppInstallFacts = { app: boolean; installations: number; allowedOwners: number };
