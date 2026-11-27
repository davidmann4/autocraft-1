// CI on the default branch of every synced repo: one GraphQL query reads each head commit and its checks,
// main_ci keeps one row per head seen, and the dashboard shows the state of each repo and when it turned red.
// Read-only: nothing is written to GitHub.
import type { Querier } from "../mirror.ts";
import { contextState, type CheckState } from "../review/checks.ts";
import { trackedNames } from "../repos.ts";
import { optionalChecks, optionalChecksOf } from "../optional-checks.ts";
import { tripMergeBreakers } from "../data/control/index.ts";
import { loadMergedInfo } from "../data/merge/index.ts";
import { autocraftTexts } from "../mainfix/status.ts";
import { classify, derive, type Culprit, type HeadRow, type MainCheck, type MainCiState } from "./classify.ts";
import { ownerOf } from "../owners.ts";
import type { HiddenRepos } from "../hidden-sql.ts";
import { loadDecidingHeads, loadRepos, loadSyncState, saveMainHeads, saveSyncState, type MainHeadSummary } from "../data/mirror/index.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";
import { warmPass } from "../build/warm-queue.ts";

/** Branch prefix of the PRs AutoCraft opens to fix a red main; the merge queue does not hold them while main is red. */
export const MAIN_FIX_BRANCH_PREFIX = "autocraft/main-ci-";

/** Repos whose current default-branch head is red. */
export async function redMainRepos(db: Db): Promise<Set<string>> {
  return new Set([...await loadDecidingHeads(db, [])].filter(([, heads]) => currentHead(heads)?.cur.state === "red").map(([repo]) => repo));
}

/** The repo's current head among its stored ones, and what derive() says of them; null when they name none. */
function currentHead<H extends MainHeadSummary>(heads: readonly H[]): { cur: H; d: NonNullable<ReturnType<typeof derive>> } | null {
  const d = derive(heads.map((h): HeadRow => ({ sha: h.head_sha, state: h.state as MainCiState, committedAt: h.committed_at, headline: h.headline, firstSeenAt: h.first_seen_at, stateChangedAt: h.state_changed_at })));
  return d ? { cur: heads.find((h) => h.head_sha === d.current.sha)!, d } : null;
}

/** Least time between two polls. */
export const POLL_EVERY_MS = 2 * 60_000;
/** Repos per query: 100 check contexts each keeps a query well under GitHub's node limit. */
const REPOS_PER_QUERY = 30;

export { optionalChecks };

/** The owner variables of mainCiQuery. */
export const mainCiVars = (repos: string[]): Record<string, string> => Object.fromEntries(repos.map((r, i) => [`o${i}`, ownerOf(r)]));

export function mainCiQuery(repos: string[]): string {
  const parts = repos.map((r, i) => `
    r${i}: repository(owner: $o${i}, name: ${JSON.stringify(r)}) {
      defaultBranchRef { name target { ... on Commit {
        oid committedDate messageHeadline
        statusCheckRollup { state contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { name conclusion status detailsUrl }
          ... on StatusContext { context state targetUrl }
        } } }
      } } }
    }`).join("");
  return `query(${repos.map((_, i) => `$o${i}: String!`).join(", ")}) {
  rateLimit { cost remaining resetAt }${parts}
}`;
}

type Ctx = { __typename?: string; name?: string; status?: string; conclusion?: string | null; detailsUrl?: string | null; context?: string; state?: string; targetUrl?: string | null };
type RepoNode = {
  defaultBranchRef?: { name: string; target?: { oid?: string; committedDate?: string; messageHeadline?: string; statusCheckRollup?: { contexts?: { nodes?: (Ctx | null)[] } } | null } | null } | null;
} | null;

export type Head = { repo: string; branch: string; sha: string; committedAt: string | null; headline: string | null; checks: MainCheck[] };

/** The heads of a reply to mainCiQuery; a repo that is gone or has no default branch is left out. */
export function parseHeads(repos: string[], data: Record<string, RepoNode | undefined>): Head[] {
  const out: Head[] = [];
  repos.forEach((repo, i) => {
    const ref = data[`r${i}`]?.defaultBranchRef;
    const t = ref?.target;
    if (!ref || !t?.oid) return;
    const checks = (t.statusCheckRollup?.contexts?.nodes ?? []).filter((c): c is Ctx => !!c).map((c) => ({
      name: c.name ?? c.context ?? "?", state: contextState(c) as CheckState, url: c.detailsUrl ?? c.targetUrl ?? null,
    }));
    out.push({ repo, branch: ref.name, sha: t.oid, committedAt: t.committedDate ?? null, headline: t.messageHeadline ?? null, checks });
  });
  return out;
}

/** Stores heads: a new row, or the row of a head seen before with its current checks; state_changed_at moves only when the state does. Returns the state of each head, keyed `repo@sha`. */
export async function saveHeads(db: Db, heads: Head[], at: string): Promise<Map<string, MainCiState>> {
  const optional = await optionalChecksOf(db);
  const saved = await saveMainHeads(db, heads.map((h) => ({
    repo: h.repo, sha: h.sha, branch: h.branch, state: classify(h.checks, optional(h.repo)),
    failing: JSON.stringify(h.checks.filter((c) => c.state === "failure").map((c) => ({ name: c.name, url: c.url }))),
    checks: JSON.stringify(h.checks), committed_at: h.committedAt, headline: h.headline,
  })), at);
  return saved as Map<string, MainCiState>;
}

/** Reads the default-branch heads of the synced repos (or of `only`) and stores them. */
export async function pollMainCi(db: Db, client: Querier, only?: string, log: (line: string) => void = () => {}): Promise<{ repos: number; heads: number }> {
  const [known, tracked] = await db.together(() => Promise.all([loadRepos(db), trackedNames(db)]));
  const repos = tracked.filter((r) => known.get(r)?.synced_at != null && (!only || r === only));
  let heads = 0;
  for (let i = 0; i < repos.length; i += REPOS_PER_QUERY) {
    const chunk = repos.slice(i, i + REPOS_PER_QUERY);
    // The time the read started: a head counts as newer than what was read from GitHub before that (src/verify/results.ts).
    const at = new Date().toISOString();
    const data = await client.query(mainCiQuery(chunk), mainCiVars(chunk));
    const parsed = parseHeads(chunk, data as Record<string, RepoNode>);
    await saveHeads(db, parsed, at);
    heads += parsed.length;
  }
  // A red head whose culprit is a PR we merged stops the merge path.
  const red = (await mainCiRepos(db)).flatMap((r) => (r.state === "red" && r.culprit?.pr ? [{ repo: r.repo, number: r.culprit.pr, sha: r.culprit.sha }] : []));
  if (red.length) {
    const merged = await loadMergedInfo(db, red.map((r) => ({ repo: r.repo, number: r.number })));
    await tripMergeBreakers(db, red.flatMap((r) => {
      const m = merged.get(`${r.repo}#${r.number}`);
      return m?.lastAt ? [{ repo: r.repo, number: r.number, mergedAt: m.lastAt, reason: `main CI of ${r.repo} is red after our merge of #${r.number}`, evidence: [`${r.repo}#${r.number}`, `${r.repo}@${r.sha.slice(0, 8)}`] }] : [];
    }));
  }
  if (!only) await saveSyncState(db, { main_ci_polled_at: new Date().toISOString() });
  // A new head, or a new toolchain image of the warm producer, queues the repo's warm build.
  const warm = await warmPass(db);
  log(`main-ci: ${heads} heads of ${repos.length} repos${warm ? `; ${warm} warm build${warm === 1 ? "" : "s"} queued` : ""}`);
  return { repos: repos.length, heads };
}

/** Polls when the last full poll is older than POLL_EVERY_MS; the sync run calls it, so it runs with the pipeline on or off. */
export async function pollMainCiIfDue(db: Db, client: Querier, now = Date.now()): Promise<boolean> {
  const at = (await loadSyncState(db)).main_ci_polled_at;
  if (at && now - Date.parse(at) < POLL_EVERY_MS - 5_000) return false;
  await pollMainCi(db, client);
  return true;
}

export type MainCiRepoRow = {
  repo: string; state: MainCiState; branch: string; headSha: string; headline: string | null; committedAt: string | null;
  failing: { name: string; url: string | null }[]; redSince: string | null; lastGreenSha: string | null; culprit: Culprit | null; updatedAt: string;
  /** What AutoCraft is doing about the red head (src/mainfix); null when nothing. */
  autocraft: string | null;
};

/** One entry per repo with stored heads, red first, then by name. `hidden` repos are left out. */
export async function mainCiRepos(db: Db, hidden: HiddenRepos = []): Promise<MainCiRepoRow[]> {
  const by = await loadDecidingHeads(db, hidden);
  const out: MainCiRepoRow[] = [];
  for (const [repo, heads] of by) {
    const at = currentHead(heads);
    if (!at) continue;
    const { cur, d } = at;
    let failing: { name: string; url: string | null }[] = [];
    try { failing = JSON.parse(cur.failing) as typeof failing; } catch { /* malformed: none shown */ }
    out.push({ repo, state: cur.state as MainCiState, branch: cur.branch, headSha: cur.head_sha, headline: cur.headline, committedAt: cur.committed_at, failing, redSince: d.redSince, lastGreenSha: d.lastGreenSha, culprit: d.culprit, updatedAt: cur.updated_at, autocraft: null });
  }
  const texts = await autocraftTexts(db, out.map((r) => ({ repo: r.repo, headSha: r.headSha, state: r.state })));
  for (const r of out) r.autocraft = texts.get(`${r.repo}\0${r.headSha}`) ?? null;
  const weight: Record<MainCiState, number> = { red: 0, optional: 1, running: 2, none: 3, green: 4 };
  return out.sort((a, b) => weight[a.state] - weight[b.state] || a.repo.localeCompare(b.repo));
}

export function summarize(rows: { state: MainCiState }[]): Record<MainCiState, number> {
  const s: Record<MainCiState, number> = { green: 0, red: 0, optional: 0, running: 0, none: 0 };
  for (const r of rows) s[r.state]++;
  return s;
}

async function show(args: string[]): Promise<void> {
  let only: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo") only = args[++i];
    else throw new Error(`unknown argument ${args[i]}\nusage: main-ci [--repo R]`);
  }
  const rows = (await mainCiRepos(await openDb())).filter((r) => !only || r.repo === only);
  console.log(`${"repo".padEnd(28)} ${"state".padEnd(9)} ${"head".padEnd(9)} ${"red since".padEnd(21)} failing`);
  for (const r of rows) {
    console.log(`${r.repo.padEnd(28)} ${r.state.padEnd(9)} ${r.headSha.slice(0, 8).padEnd(9)} ${(r.redSince ?? "-").padEnd(21)} ${r.failing.map((f) => f.name).join(", ") || "-"}${r.culprit ? `  culprit ${r.culprit.sha.slice(0, 8)}${r.culprit.pr ? ` #${r.culprit.pr}` : ""}` : ""}`);
  }
}

export const commands = {
  "main-ci": { summary: "CI state of each synced repo's default branch: [--repo R]", run: show },
};
