// Which items of a key source the pipeline works on (the scope rule of fragments.ts `inScopeExpr`), and what decides it for a repo.
import type { RepoScope } from "../../core/scope.ts";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import { closeDueIn, inScopeExpr, startedRepo } from "./fragments.ts";
import type { RefKey } from "./types.ts";

/** The refs of `keys` that are in scope, whatever their kind or state. 1 statement. */
export async function loadInScope(db: Db, keys: KeySource): Promise<Set<RefKey>> {
  if (Array.isArray(keys) && keys.length === 0) return new Set();
  const q = queryDb(db);
  const rows = await q.all((q.k as any).selectFrom(resolveKeys(db, keys, "sk")).select(["sk.repo", "sk.number"])
    .where((eb: any) => inScopeExpr(db, eb, "sk.repo", "sk.number")), { label: "workflow.loadInScope" }) as { repo: string; number: number }[];
  return new Set(rows.map((r) => `${r.repo}#${Number(r.number)}`));
}

/** The columns of a repo's scope facts over `t` (an alias of `tracked_repos`). */
export const repoScopeCols = (eb: kx.AnyEb, t: string) =>
  [eb.ref(`${t}.pipeline`).as("pipeline"), startedRepo(eb, `${t}.name`).as("live"), closeDueIn(eb, `${t}.name`).as("close")] as const;

export const repoScopeOf = (r: { pipeline: unknown; live: unknown; close: unknown }): RepoScope =>
  ({ pipeline: !!Number(r.pipeline), live: !!Number(r.live), close: !!Number(r.close) });

/** What decides the scope of each tracked repo (of `repos`), in name order. 1 statement. */
export async function loadRepoScopes(db: Db, repos?: readonly string[]): Promise<Map<string, RepoScope>> {
  if (repos && !repos.length) return new Map();
  const q = queryDb(db);
  const rows = await q.all((q.k as any).selectFrom("main.tracked_repos as t").select((eb: any) => ["t.name as name", ...repoScopeCols(eb, "t")])
    .$if(!!repos, (b: any) => b.where(kx.inList(db, "t.name", [...repos!]))).orderBy("t.name"), { label: "workflow.loadRepoScopes" }) as { name: string; pipeline: unknown; live: unknown; close: unknown }[];
  return new Map(rows.map((r) => [r.name, repoScopeOf(r)]));
}
