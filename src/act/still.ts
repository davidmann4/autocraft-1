// Whether a person still counts when their earlier press or command is carried out now: their role and write access.
import { loadActFacts, permKey, standing, type Standing } from "../data/access/index.ts";
import type { Db } from "../db/index.ts";
import { settlesLive, type RefreshDeps } from "../preapproval/permissions.ts";

/**
 * Whether the person may act on every one of `repos` by the act rule: "no" names the first they may not act on, "unknown" the first GitHub
 * could not answer for (the caller waits). `live`: the caller asked GitHub with the person's own token, so only the role is
 * read here.
 */
export async function stillActs(db: Db, login: string, repos: string[], o: { live?: boolean; permission?: RefreshDeps["permission"] } = {}): Promise<{ ok: true } | { ok: false; standing: Exclude<Standing, "yes">; repo: string }> {
  if (o.live) {
    const facts = await loadActFacts(db, repos.map((repo) => ({ login, repo })));
    const gone = repos.find((repo) => { const f = facts.get(permKey(login, repo)); return standing(f && { ...f, perm: null }, "app") === "no"; });
    return gone === undefined ? { ok: true } : { ok: false, standing: "no", repo: gone };
  }
  let unsure: string | null = null;
  for (const repo of repos) {
    const v = await settlesLive(db, login, repo, o.permission, { accepted: true });
    if (v === "no") return { ok: false, standing: "no", repo };
    if (v === "unknown") unsure ??= repo;
  }
  return unsure === null ? { ok: true } : { ok: false, standing: "unknown", repo: unsure };
}
