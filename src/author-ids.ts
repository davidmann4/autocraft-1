// Binds each author login with PR history to the GitHub account id it belongs to, so a login that later passes to another account
// does not inherit the history (tiersOf reads author_ids). The sync binds ids as it writes rows; this step covers history written earlier.
import { ownerOf } from "./owners.ts";
import type { Querier } from "./mirror.ts";
import type { Db } from "./db/index.ts";
import { bindAuthorIds, bindKnownAuthorIds, loadUnboundLoginPrs } from "./data/mirror/index.ts";

const BATCH = 40;

/** Logins whose merged or closed PRs count toward a tier and that have no bound account id. */
export async function unboundLogins(db: Db): Promise<string[]> {
  return (await loadUnboundLoginPrs(db)).map((p) => p.login);
}

/**
 * The author account of `n` pull requests of one owner (`$owner`), passed as $r{i} (repository name) and $k{i} (number).
 * A deleted account reads as a null author.
 */
export function authorIdsQuery(n: number): string {
  const decl = Array.from({ length: n }, (_, i) => `, $r${i}: String!, $k${i}: Int!`).join("");
  const body = Array.from({ length: n }, (_, i) => `p${i}: repository(owner: $owner, name: $r${i}) { pullRequest(number: $k${i}) { author { __typename ... on User { databaseId } ... on Bot { databaseId } } } }`).join(" ");
  return `query($owner: String!${decl}) { rateLimit { cost remaining resetAt } ${body} }`;
}

/** Bound for an account GitHub no longer has: no later holder of the login is the same person. */
export const DELETED_ACCOUNT_ID = -1;

type Pr = { login: string; repo: string; number: number };

async function lookup(client: Querier, owner: string, prs: Pr[], out: Map<string, number>): Promise<void> {
  if (!prs.length) return;
  const vars: Record<string, string | number> = { owner };
  prs.forEach((p, i) => { vars[`r${i}`] = p.repo; vars[`k${i}`] = p.number; });
  try {
    const data = await client.query(authorIdsQuery(prs.length), vars);
    prs.forEach((p, i) => {
      const pr = data?.[`p${i}`]?.pullRequest;
      if (!pr) return;
      const id = pr.author?.databaseId;
      if (typeof id === "number") out.set(p.login, id);
      else if (pr.author === null) out.set(p.login, DELETED_ACCOUNT_ID);
    });
  } catch (e) {
    // A repository or pull request GitHub cannot find, or one the token may not read, fails the whole query: split until those
    // stand alone, and leave them unbound.
    const type = (e as { type?: string })?.type;
    if (type !== "NOT_FOUND" && type !== "FORBIDDEN") throw e;
    if (prs.length === 1) return;
    const mid = prs.length >> 1;
    await lookup(client, owner, prs.slice(0, mid), out);
    await lookup(client, owner, prs.slice(mid), out);
  }
}

/**
 * Binds the logins that have merged or closed PRs and no account id. A login can have passed to another account, so the id comes
 * from the login's own oldest merged or closed PR (what GitHub reports as its author), never from the login's current holder.
 * Ids stored on item rows are used only when every row of the login has one. One batched pass per owner; nothing when all are bound.
 */
export async function backfillAuthorIds(db: Db, client: Querier | null): Promise<number> {
  let n = await bindKnownAuthorIds(db);
  if (!client) return n;
  const oldest = await loadUnboundLoginPrs(db);
  if (!oldest.length) return n;
  const byOwner = new Map<string, Pr[]>();
  for (const p of oldest) (byOwner.get(ownerOf(p.repo)) ?? byOwner.set(ownerOf(p.repo), []).get(ownerOf(p.repo))!).push(p);
  const found = new Map<string, number>();
  const skipped: string[] = [];
  for (const [owner, prs] of byOwner) {
    try {
      for (let i = 0; i < prs.length; i += BATCH) await lookup(client, owner, prs.slice(i, i + BATCH), found);
    } catch (e) {
      // An owner no token can read (e.g. the app is not installed there) leaves its logins unbound; the other owners go on.
      if (!/not installed|FORBIDDEN|Resource not accessible/i.test(String((e as Error)?.message))) throw e;
      skipped.push(owner);
    }
  }
  if (skipped.length) console.log(`author ids: skipped ${skipped.join(", ")} (no readable token)`);
  n += await bindAuthorIds(db, [...found].map(([login, id]) => ({ login, id })));
  return n;
}
