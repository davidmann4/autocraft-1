// The GitHub accounts the GitHub App may be installed on. GitHub lets any account install a public app, so AutoCraft
// keeps its own list and uninstalls the app from other accounts: on the installation's webhook, and in a sweep the sync
// run makes every 10 minutes. An empty list turns this off. Installations match the list by account id, so a renamed
// account keeps its place and a reused login gains nothing.
// Nothing AutoCraft depends on is uninstalled: turning enforcement on lists every account installed at that moment and
// every owner of a tracked or filing-only repo and of the app; tracking a repo or adding a filing-only one lists its
// owner; such an owner cannot be taken off the list; and before any removal the installation's repos are read, and one
// that is tracked or filing-only keeps the installation.
import type { AppSecrets } from "../dash/server/config.ts";
import * as access from "../data/access/index.ts";
import * as control from "../data/control/index.ts";
import * as discord from "../data/discord/index.ts";
import * as mirror from "../data/mirror/index.ts";
import { DEFAULT_OWNER, OWNER } from "../owners.ts";
import { accountByLogin, AppError, installationRepos, installations, type AppDeps, type Installation } from "./app.ts";
import { readAppSecrets } from "./install-token.ts";
import { removeInstallation } from "./write.ts";
import type { Db } from "../db/index.ts";

export class AllowedOwnerError extends Error {}

export type AllowedOwner = { login: string; accountId: number | null; addedBy: string; addedAt: string };
type Inst = Pick<Installation, "id" | "owner" | "accountId">;

/** The audit login of the removals. */
const REMOVER = "app-install-check";
export const SWEEP_EVERY_MS = 10 * 60_000;
const SWEPT_AT = "app_install_sweep_at";
/** How long a removal shows as a health warning, unless an operator acknowledges it first; also how often a kept installation's refusal is recorded again. */
export const FOREIGN_WARN_MS = 24 * 3600_000;

const lower = (s: string): string => s.toLowerCase();

export async function allowedOwners(db: Db): Promise<AllowedOwner[]> {
  return (await access.listAllowedOwners(db)).map((r) => ({ login: r.login, accountId: r.account_id === null ? null : Number(r.account_id), addedBy: r.added_by, addedAt: r.added_at }));
}

const audit = async (db: Db, login: string, action: string, target: string | null, details?: unknown): Promise<void> => await control.addAudit(db, [{ login, action, target, details }]);

/** The list's row an installation's account matches: by account id, or by login for a row whose id is not known yet. */
export function rowFor(rows: AllowedOwner[], inst: Pick<Installation, "owner" | "accountId">): AllowedOwner | null {
  if (inst.accountId !== null) {
    const byId = rows.find((r) => r.accountId === inst.accountId);
    if (byId) return byId;
  }
  return rows.find((r) => r.accountId === null && lower(r.login) === lower(inst.owner)) ?? null;
}

/**
 * Accounts that stay allowed whatever the list says, by lower-case login, with the reason: the owners of tracked and
 * filing-only repos, and the account the app belongs to.
 */
export async function keptOwners(db: Db, appOwner: string | null): Promise<Map<string, { login: string; why: string }>> {
  const out = new Map<string, { login: string; why: string }>();
  const put = (login: string, why: string): void => { if (!out.has(lower(login))) out.set(lower(login), { login, why }); };
  if (appOwner) put(appOwner, `${appOwner} owns the GitHub App`);
  for (const r of await keptRepos(db)) put(r.owner, `${r.owner} owns the ${r.kind} repo ${r.name}`);
  return out;
}

async function keptRepos(db: Db): Promise<{ owner: string; name: string; kind: "tracked" | "filing-only" }[]> {
  const [tracked, repos, filing] = await db.together(() => Promise.all([control.loadTrackedRepos(db), mirror.loadRepos(db, { all: true }), discord.listFilingRepos(db)]));
  return [...[...tracked.keys()].map((name) => ({ name, owner: repos.get(name)?.owner ?? DEFAULT_OWNER, kind: "tracked" as const })),
    ...filing.map((f) => ({ owner: f.owner, name: f.name, kind: "filing-only" as const }))];
}

/** Whether `login` is on the list; true for every login while the list is empty (nothing is enforced). */
export async function ownerAllowed(db: Db, login: string): Promise<boolean> {
  const owners = await allowedOwners(db);
  return !owners.length || owners.some((o) => lower(o.login) === lower(login));
}

/** GitHub reads of an operator's change: a GitHub failure becomes an AllowedOwnerError the operator sees. */
async function readGithub<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof AppError) throw new AllowedOwnerError(`GitHub could not be read: ${e.message}`);
    throw e;
  }
}

async function insertOwner(db: Db, by: string, row: { login: string; accountId: number | null }, details: Record<string, unknown>): Promise<void> {
  const { inserted } = await access.addAllowedOwners(db, [row], by);
  if (inserted.length) await audit(db, by, "app-owner-allow", row.login, { accountId: row.accountId, ...details });
}

/**
 * Puts an account on the list, with its GitHub account id. The first account listed turns enforcement on, so every
 * account the app is installed on at that moment and every account that must stay allowed (keptOwners) are listed with
 * it. Audited as `app-owner-allow`, one row per account, the others with `with` and their `reason`.
 */
export async function allowOwner(db: Db, by: string, login: string, app: AppSecrets | null, deps: AppDeps = {}): Promise<AllowedOwner[]> {
  const name = login.trim();
  if (!OWNER.test(name)) throw new AllowedOwnerError("That is not a GitHub account name.");
  if (!app) throw new AllowedOwnerError("No GitHub App is registered.");
  const owners = await allowedOwners(db);
  if (owners.some((o) => lower(o.login) === lower(name))) throw new AllowedOwnerError(`${name} is already an allowed owner.`);
  const list = await readGithub(() => installations(app, deps));
  const acct = await readGithub(() => accountByLogin(app, name, deps, list));
  if (!acct) throw new AllowedOwnerError(`GitHub has no account ${name}.`);
  const same = owners.find((o) => o.accountId === acct.id);
  if (same) throw new AllowedOwnerError(`${acct.login} is already an allowed owner, as ${same.login}.`);
  const rows: { login: string; accountId: number | null; details: Record<string, unknown> }[] = [{ login: acct.login, accountId: acct.id, details: {} }];
  if (!owners.length) {
    const has = (login: string) => rows.some((r) => lower(r.login) === lower(login));
    for (const i of list) if (!has(i.owner)) rows.push({ login: i.owner, accountId: i.accountId, details: { with: acct.login, reason: "installed when enforcement was turned on" } });
    for (const k of (await keptOwners(db, app.owner?.login ?? null)).values()) {
      if (has(k.login)) continue;
      let id: number | null = null;
      try { id = (await accountByLogin(app, k.login, deps, list))?.id ?? null; } catch { id = null; }
      rows.push({ login: k.login, accountId: id, details: { with: acct.login, reason: k.why } });
    }
  }
  // Every row of the change or none: a half-written first list could leave out an account it was meant to keep.
  await db.write(async () => {
    const { inserted } = await access.addAllowedOwners(db, rows, by);
    const added = new Set(inserted.map((r) => r.login));
    await control.addAudit(db, rows.filter((r) => added.has(r.login)).map((r) => ({ login: by, action: "app-owner-allow", target: r.login, details: { accountId: r.accountId, ...r.details } })));
  });
  return await allowedOwners(db);
}

/**
 * While enforcement is on, lists the owner of a repo just tracked or added as filing-only, so its installation is never
 * removed. The account id is read when GitHub answers; otherwise the row matches by login until a sweep fills it.
 */
export async function listRepoOwner(db: Db, by: string, owner: string, reason: "track" | "filing", deps: AppDeps & { app?: AppSecrets | null } = {}): Promise<void> {
  const owners = await allowedOwners(db);
  if (!owners.length || owners.some((o) => lower(o.login) === lower(owner))) return;
  const app = deps.app === undefined ? readAppSecrets() : deps.app;
  let acct: { id: number; login: string } | null = null;
  try { acct = app ? await accountByLogin(app, owner, deps) : null; } catch { acct = null; }
  if (acct && owners.some((o) => o.accountId === acct.id)) return;
  await insertOwner(db, by, { login: acct?.login ?? owner, accountId: acct?.id ?? null }, { with: reason });
}

/**
 * Takes an account off the list. Refused for an account that must stay allowed: by login, by the account id of a kept
 * owner, or because its installation covers a tracked or filing-only repo (`repos` keeps an owner's old login after a
 * rename, so the repo names decide). Returns false when it was not listed. Audited as `app-owner-remove`.
 */
export async function removeOwner(db: Db, by: string, login: string, app: AppSecrets | null, deps: AppDeps = {}): Promise<boolean> {
  const row = (await allowedOwners(db)).find((o) => lower(o.login) === lower(login.trim()));
  if (!row) return false;
  const keptBy = await keptOwners(db, app?.owner?.login ?? null);
  const kept = keptBy.get(lower(row.login));
  if (kept) throw new AllowedOwnerError(`${kept.why}, so it stays an allowed owner.`);
  if (app && row.accountId !== null) {
    const list = await readGithub(() => installations(app, deps));
    for (const k of keptBy.values()) {
      const acct = await readGithub(() => accountByLogin(app, k.login, deps, list));
      if (acct?.id === row.accountId) throw new AllowedOwnerError(`${k.why}, so it stays an allowed owner.`);
    }
    const inst = list.find((i) => i.accountId === row.accountId);
    const covered = inst ? await readGithub(() => coveredKeptRepo(db, app, inst.id, deps)) : null;
    if (covered) throw new AllowedOwnerError(`${row.login}'s installation covers ${covered}, so it stays an allowed owner.`);
  }
  await db.write(async () => {
    await access.removeAllowedOwner(db, row.login);
    await audit(db, by, "app-owner-remove", row.login, { accountId: row.accountId });
  });
  return true;
}

export type Verdict = "off" | "allowed" | { kept: string } | "foreign";

/** What enforcement does with an installation. A matching row takes GitHub's current login and, when it had none, the account id. */
export async function verdictFor(db: Db, inst: Pick<Installation, "owner" | "accountId">, appOwner: string | null): Promise<Verdict> {
  const owners = await allowedOwners(db);
  if (!owners.length) return "off";
  const row = rowFor(owners, inst);
  if (row) {
    if (row.login !== inst.owner || (row.accountId === null && inst.accountId !== null)) {
      try {
        await access.renameAllowedOwner(db, row.login, inst.owner, { accountId: inst.accountId ?? row.accountId });
      } catch { /* another row holds the login: left for an operator */ }
    }
    return "allowed";
  }
  const kept = (await keptOwners(db, appOwner)).get(lower(inst.owner));
  return kept ? { kept: kept.why } : "foreign";
}

/**
 * The first tracked or filing-only repo an installation covers, as GitHub names it (`owner/name`), or null. Matched by
 * name alone: names are unique across owners, and `repos` keeps an owner's old login after a rename. A list cut at
 * installationRepos's cap throws, so an installation too large to read is kept.
 */
async function coveredKeptRepo(db: Db, app: AppSecrets, id: number, deps: AppDeps): Promise<string | null> {
  const kept = new Set((await keptRepos(db)).map((r) => lower(r.name)));
  return (await installationRepos(app, id, deps, true)).find((n) => kept.has(lower(n.slice(n.indexOf("/") + 1)))) ?? null;
}

export type EnforceDeps = AppDeps & { log?: (line: string) => void };

/**
 * Uninstalls the app from `inst`'s account when the account is not allowed and the installation covers no tracked or
 * filing-only repo. Returns whether it is gone. A failed removal is audited and logged, not thrown.
 */
export async function enforceOne(db: Db, app: AppSecrets, inst: Inst, found: "webhook" | "sweep", deps: EnforceDeps = {}): Promise<boolean> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const v = await verdictFor(db, inst, app.owner?.login ?? null);
  if (v === "off" || v === "allowed") return false;
  if (typeof v === "object") {
    log(`github app: installation ${inst.id} on ${inst.owner} is not on the allowed owners list but kept: ${v.kept}`);
    return false;
  }
  let covered: string | null;
  try {
    covered = await coveredKeptRepo(db, app, inst.id, deps);
  } catch (e) {
    log(`github app: installation ${inst.id} on ${inst.owner} not removed: its repos could not be read: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    return false;
  }
  if (covered) {
    log(`github app: installation ${inst.id} on ${inst.owner} is not on the allowed owners list but covers ${covered}; not removed`);
    await recordRefusal(db, inst, found, covered);
    return false;
  }
  try {
    const already = await removeInstallation({ db, login: REMOVER }, { app, installationId: inst.id, account: inst.owner, accountId: inst.accountId, found, ...(deps.apiBase ? { apiBase: deps.apiBase } : {}) });
    log(`github app: ${already ? "installation already gone" : "removed installation"} ${inst.id} on ${inst.owner}, not an allowed owner`);
    return true;
  } catch (e) {
    log(`github app: removing installation ${inst.id} on ${inst.owner}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    return false;
  }
}

/** A failed `app-install-removed` row for an installation kept because it covers a repo AutoCraft uses: once per installation per FOREIGN_WARN_MS. */
async function recordRefusal(db: Db, inst: Inst, found: string, covered: string): Promise<void> {
  const from = new Date(Date.now() - FOREIGN_WARN_MS).toISOString();
  const recent = await control.listAudit(db, { actions: ["app-install-removed"], targets: [inst.owner], since: from });
  if (recent.some((r) => r.details?.refused !== undefined && r.details.installation === inst.id)) return;
  await audit(db, REMOVER, "app-install-removed", inst.owner, { installation: inst.id, account: inst.owner, accountId: inst.accountId, found, state: "failed", refused: covered, error: `not removed: it covers ${covered}` });
}

/** Lists the app's installations and removes those on accounts not allowed. Returns how many were removed; nothing is read while the list is empty. */
export async function sweepInstallations(db: Db, app: AppSecrets, deps: EnforceDeps = {}): Promise<number> {
  const owners = await allowedOwners(db);
  if (!owners.length) return 0;
  const list = await installations(app, deps);
  // Rows listed while GitHub could not tell their account id get it now, so they stop matching by login.
  const found: { login: string; accountId: number }[] = [];
  for (const o of owners.filter((r) => r.accountId === null)) {
    try {
      const acct = await accountByLogin(app, o.login, deps, list);
      if (acct) found.push({ login: o.login, accountId: acct.id });
    } catch (e) {
      (deps.log ?? console.log)(`github app: account id of ${o.login}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }
  await access.setAllowedOwnerAccounts(db, found);
  let n = 0;
  for (const i of list) if (await enforceOne(db, app, i, "sweep", deps)) n++;
  return n;
}

/** The sweep when the last one is SWEEP_EVERY_MS old; the sync run calls it, so of two replicas only the periodic leader does. */
export async function sweepInstallationsIfDue(db: Db, now = Date.now(), deps: EnforceDeps & { app?: AppSecrets | null } = {}): Promise<boolean> {
  const app = deps.app === undefined ? readAppSecrets() : deps.app;
  if (!app) return false;
  const at = await control.setting(db, SWEPT_AT);
  if (at && now - Date.parse(at) < SWEEP_EVERY_MS - 5_000) return false;
  // Stamped first: a sweep GitHub refuses waits for the next turn instead of retrying every minute.
  await control.writeSetting(db, SWEPT_AT, new Date(now).toISOString());
  await sweepInstallations(db, app, deps);
  return true;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

/** A verified `installation` (created, new permissions accepted) or `installation_repositories` (added) delivery: enforces at once. */
export async function installationEvent(db: Db, event: string, payload: unknown, deps: EnforceDeps & { app?: AppSecrets | null } = {}): Promise<boolean> {
  const p = obj(payload);
  const acts = event === "installation" ? ["created", "new_permissions_accepted"] : event === "installation_repositories" ? ["added"] : [];
  if (!acts.includes(String(p.action))) return false;
  const inst = obj(p.installation);
  const account = obj(inst.account);
  const owner = account.login;
  if (typeof inst.id !== "number" || typeof owner !== "string" || !owner) return false;
  const app = deps.app === undefined ? readAppSecrets() : deps.app;
  if (!app) return false;
  return await enforceOne(db, app, { id: inst.id, owner, accountId: typeof account.id === "number" ? account.id : null }, "webhook", deps);
}

export type Removal = { account: string; at: string; /** Set when the installation was kept: the tracked or filing-only repo it covers. */ refused?: string };

/** Removals and refusals of the last FOREIGN_WARN_MS that no operator has acknowledged, newest first. Installations already gone do not count. */
export async function unackedRemovals(db: Db, nowMs: number): Promise<Removal[]> {
  const from = new Date(nowMs - FOREIGN_WARN_MS).toISOString();
  const ack = (await control.loadAuditMax(db, "app-foreign-install-ack")).get("app-foreign-install-ack") ?? null;
  const rows = await control.listAudit(db, { actions: ["app-install-removed"], since: ack && ack > from ? ack : from, order: "desc" });
  return rows.flatMap((r): Removal[] => {
    if (!r.target || (ack && r.at <= ack)) return [];
    const d = r.details ?? {};
    if (typeof d.refused === "string") return [{ account: r.target, at: r.at, refused: d.refused }];
    return d.state === "done" && !d.already ? [{ account: r.target, at: r.at }] : [];
  });
}

/** An operator acknowledges the removals so far: their warning clears until the next one. */
export async function ackRemovals(db: Db, by: string): Promise<void> {
  await audit(db, by, "app-foreign-install-ack", "github-app", {});
}
