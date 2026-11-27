// The repos the pipeline works, one rule per kind of work (src/core/scope.ts).
import { repoInScope, type ScopeFor } from "../core/scope.ts";
import type { Db } from "../db/index.ts";
import { loadRepoScopes } from "../data/workflow/index.ts";

/** The repos in scope for `o.for` (`work` when omitted). */
export async function scopeRepos(db: Db, o: { for?: ScopeFor } = {}): Promise<Set<string>> {
  return new Set([...await loadRepoScopes(db)].filter(([, r]) => repoInScope(r, o.for ?? "work")).map(([name]) => name));
}

/** Whether `repo` is in scope for `what`. */
export const inRepoScope = async (db: Db, repo: string, what: ScopeFor): Promise<boolean> => repoInScope((await loadRepoScopes(db, [repo])).get(repo), what);
