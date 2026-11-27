// reads: (none; composes loaders)
// Which repos a viewer may see: the inputs of the rule and the per-request `Scope`.
import type { AliasableExpression, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import { inList } from "../../db/kx.ts";
import * as access from "../access/index.ts";
import * as control from "../control/index.ts";
import * as mirror from "../mirror/index.ts";
import * as security from "../security/index.ts";
import type { HiddenRepos, Permission, Role, Scope, VisibilityInputs } from "./types.ts";

/** Tracked repos, repos ever tracked and the mirror's repos, in one wave. */
export async function loadVisibilityInputs(db: Db): Promise<VisibilityInputs> {
  const [tracked, everTracked, repos] = await db.together(() => Promise.all([control.loadTrackedRepos(db), control.loadEverTracked(db), mirror.loadRepos(db, { all: true })]));
  return { tracked, everTracked, repos };
}

/** Tracked repos the login may see: operators every one; others the public ones and those where their cached permission is a read or better. */
export function visibleNames(inputs: VisibilityInputs, role: Role, perms: Map<string, Permission>): string[] {
  const tracked = [...inputs.tracked.keys()].sort();
  if (role === "operator") return tracked;
  return tracked.filter((r) => inputs.repos.get(r)?.visibility?.toLowerCase() === "public" || perms.has(r));
}

/** Every repo name the database knows, tracked or not, sorted. */
export const knownNames = (inputs: VisibilityInputs): string[] => [...new Set([...inputs.repos.keys(), ...inputs.tracked.keys(), ...inputs.everTracked])].sort();

const PERMS = new Set<string>(["read", "triage", "write", "maintain", "admin"]);

/** The scope of one request, from cached permission rows only (the live GitHub check runs in the session layer before the handler). */
export async function loadScope(db: Db, who: { login: string | null; role: Role }, o: { project?: string | null } = {}): Promise<Scope> {
  const staff = who.role === "operator" || who.role === "maintainer";
  const inputs = await loadVisibilityInputs(db);
  const nonPublic = [...inputs.tracked.keys()].filter((r) => inputs.repos.get(r)?.visibility?.toLowerCase() !== "public");
  const [permRows, own, quiet] = await db.together(() => Promise.all([
    who.login && who.role !== "operator" ? access.loadPermissionsForRepos(db, who.login, nonPublic) : Promise.resolve(new Map<string, { permission: string; checkedAt: string }>()),
    access.loadOwnLogins(db),
    staff ? Promise.resolve(new Set<string>()) : security.listQuietPrs(db),
  ]));
  const perms = new Map<string, Permission>();
  for (const [repo, e] of permRows) if (PERMS.has(e.permission)) perms.set(repo, e.permission === "read" || e.permission === "triage" ? "read" : e.permission === "admin" ? "admin" : "write");
  const allRepos = visibleNames(inputs, who.role, perms);
  const repos = o.project && allRepos.includes(o.project) ? [o.project] : allRepos;
  const known = knownNames(inputs);
  const visible = new Set(allRepos);
  const hidden: HiddenRepos = who.role === "operator" ? [] : Object.assign(known.filter((r) => !visible.has(r)), { visible: allRepos });
  return { login: who.login, role: who.role, staff, operator: who.role === "operator", repos, allRepos, hidden, quiet, own, perms };
}

/** Keeps only the repos in `col` the viewer may see; null when nothing is hidden. */
export function excludeHiddenExpr(db: Db, col: string, hidden: HiddenRepos): AliasableExpression<SqlBool> | null {
  if (hidden.visible) return inList(db, col, hidden.visible);
  return hidden.length ? inList(db, col, hidden, "text", true) : null;
}
