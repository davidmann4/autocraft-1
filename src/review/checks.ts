// CI and merge state of PR heads: one GraphQL query per chunk of PRs, stored in pr_checks.
import { ownerOf } from "../owners.ts";
import type { Querier } from "../mirror.ts";
import { overallsAt, type Suite } from "../merge/ci-approval.ts";
import type { Db } from "../db/index.ts";
import { resolvePushes } from "../data/control/index.ts";
import { recordRuns } from "../data/merge/index.ts";
import { noteMergeable } from "../merge/mergeable.ts";
import { settlePushing } from "../prepush/settle.ts";
import { listItems, loadChecks, saveChecks as saveCheckRows, SAVE_CHECKS_ROWS } from "../data/mirror/index.ts";

/** PRs per query: 100 check contexts each keeps a query well under GitHub's node limit. */
export const CHECKS_PER_QUERY = 40;

export type CheckState = "success" | "failure" | "pending" | "skipped";
export type Overall = "success" | "failure" | "pending" | "none";

export type PrChecks = {
  repo: string; number: number; head_oid: string; state: string; is_draft: boolean;
  overall: Overall; checks: { name: string; state: CheckState }[];
  mergeable: string | null; maintainer_can_modify: boolean;
  /** The PR comes from a fork, and the workflow runs' check suites at its head. */
  cross_repo?: boolean; suites?: Suite[];
};

export function checksQuery(numbers: number[]): string {
  const prs = numbers.map((n) => `
    pr${n}: pullRequest(number: ${n}) {
      number state isDraft headRefOid mergeable maintainerCanModify isCrossRepository
      commits(last: 1) { nodes { commit { oid
        checkSuites(last: 20, filterBy: { appId: 15368 }) { nodes { status conclusion workflowRun { databaseId event workflow { name } } } }
        statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion }
        ... on StatusContext { context state }
      } } } } } }
    }`).join("");
  return `query($owner: String!, $name: String!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {${prs}
  }
}`;
}

type Ctx = { __typename?: string; name?: string; status?: string; conclusion?: string | null; context?: string; state?: string };

export function contextState(c: Ctx): CheckState {
  if (c.__typename === "StatusContext") {
    const s = c.state ?? "";
    return s === "SUCCESS" ? "success" : s === "FAILURE" || s === "ERROR" ? "failure" : "pending";
  }
  if (c.status !== "COMPLETED") return "pending";
  switch (c.conclusion) {
    case "SUCCESS": return "success";
    case "NEUTRAL": case "SKIPPED": return "skipped";
    default: return "failure"; // FAILURE, TIMED_OUT, CANCELLED, ACTION_REQUIRED, STARTUP_FAILURE, STALE
  }
}

export function overallOf(states: CheckState[]): Overall {
  if (!states.length) return "none";
  if (states.includes("failure")) return "failure";
  if (states.includes("pending")) return "pending";
  return states.includes("success") ? "success" : "none";
}

type PrNode = {
  number: number; state: string; isDraft: boolean; headRefOid: string; mergeable: string | null; maintainerCanModify: boolean; isCrossRepository?: boolean;
  commits?: { nodes?: { commit?: { oid?: string; checkSuites?: { nodes?: ({ status?: string; conclusion?: string | null; workflowRun?: { databaseId?: number | null; event?: string; workflow?: { name?: string } | null } | null } | null)[] }; statusCheckRollup?: { contexts?: { nodes?: Ctx[] } } | null } }[] };
};

/** The commit the checks belong to, only when it is the PR's head: CI state and approvable runs never come from another commit. */
function headCommit(node: PrNode): NonNullable<NonNullable<PrNode["commits"]>["nodes"]>[number]["commit"] {
  const c = node.commits?.nodes?.[0]?.commit;
  return c && c.oid === node.headRefOid ? c : undefined;
}

function suitesOf(node: PrNode): Suite[] {
  const out: Suite[] = [];
  for (const s of headCommit(node)?.checkSuites?.nodes ?? []) {
    const id = s?.workflowRun?.databaseId;
    if (s && typeof id === "number") out.push({ id, name: s.workflowRun?.workflow?.name ?? "", event: (s.workflowRun?.event ?? "").toLowerCase(), status: s.status ?? "", conclusion: s.conclusion ?? null });
  }
  return out;
}

/** Parses the repository object of a checks query; PRs that GitHub returned as null are left out. */
export function parseChecks(repo: string, repository: Record<string, PrNode | null>): PrChecks[] {
  const out: PrChecks[] = [];
  for (const node of Object.values(repository ?? {})) {
    if (!node || typeof node.number !== "number") continue;
    const head = headCommit(node);
    const ctx = head?.statusCheckRollup?.contexts?.nodes ?? [];
    const checks = ctx.filter(Boolean).map((c) => ({ name: c.name ?? c.context ?? "?", state: contextState(c) }));
    const suites = suitesOf(node);
    // Checks read for another commit, or workflow runs not yet finished at the head, are not "no CI": wait for them.
    const unsettled = !head || suites.some((x) => x.status !== "" && x.status !== "COMPLETED");
    const overall = overallOf(checks.map((c) => c.state));
    out.push({
      repo, number: node.number, head_oid: node.headRefOid, state: node.state, is_draft: !!node.isDraft,
      overall: unsettled && overall !== "failure" ? "pending" : overall, checks,
      mergeable: node.mergeable ?? null, maintainer_can_modify: !!node.maintainerCanModify,
      cross_repo: !!node.isCrossRepository, suites,
    });
  }
  return out;
}

/**
 * Stores checks rows and what follows from them (approvable runs, push outcomes, unknown merge states). Each part reads its
 * rows in one query per batch and writes in multi-row statements: on Postgres every statement is a network round trip.
 */
export async function saveChecks(db: Db, rows: PrChecks[], at = new Date().toISOString()): Promise<void> {
  // A PR read twice keeps its last reading: a multi-row upsert cannot touch one row twice.
  rows = [...new Map(rows.map((r) => [`${r.repo}#${r.number}`, r])).values()];
  await saveCheckRows(db, rows.map((r) => ({
    repo: r.repo, number: r.number, head_oid: r.head_oid, state: r.state, is_draft: r.is_draft ? 1 : 0, overall: r.overall, checks: JSON.stringify(r.checks),
    mergeable: r.mergeable, maintainer_can_modify: r.maintainer_can_modify ? 1 : 0, fetched_at: at,
  })), at);
  await recordRuns(db, rows, at);
  await settlePushing(db, rows, at);
  await resolvePushes(db, rows.map((r) => ({ repo: r.repo, number: r.number, head_oid: r.head_oid, checks: JSON.stringify(r.checks) })), at);
  await noteMergeable(db, rows, at);
}

/** Fetches and stores the checks of the given PRs (all open PRs of the repo when none are given). */
export async function refreshChecks(db: Db, client: Querier, repo: string, numbers?: number[], log: (line: string) => void = () => {}): Promise<PrChecks[]> {
  const list = numbers ?? (await listItems(db, { repos: [repo], kind: "pr", states: ["OPEN"], inScope: true }, "ref")).map((r) => r.number);
  const all: PrChecks[] = [];
  // Rows are stored once BATCH_ROWS are read (and at the end), so the statements per PR stay a fraction of one.
  let unsaved: PrChecks[] = [];
  for (let i = 0; i < list.length; i += CHECKS_PER_QUERY) {
    const chunk = list.slice(i, i + CHECKS_PER_QUERY);
    let rows: PrChecks[];
    try {
      const data = await client.query(checksQuery(chunk), { owner: ownerOf(repo), name: repo });
      rows = parseChecks(repo, (data as { repository: Record<string, PrNode | null> }).repository);
    } catch (e) {
      // The rows read before a failed query are stored: a chunk that keeps failing loses only its own rows and the ones after it.
      if (unsaved.length) await saveChecks(db, unsaved).catch((s: unknown) => log(`checks: ${repo}: storing the rows read before the failed query failed: ${String((s as Error).message ?? s)}`));
      throw e;
    }
    unsaved.push(...rows);
    all.push(...rows);
    if (unsaved.length >= SAVE_CHECKS_ROWS) { await saveChecks(db, unsaved); unsaved = []; }
  }
  if (unsaved.length) await saveChecks(db, unsaved);
  log(`checks: ${repo}: ${all.length} PRs (${(["success", "failure", "pending", "none"] as const).map((o) => `${all.filter((r) => r.overall === o).length} ${o}`).join(", ")})`);
  return all;
}

/** The stored checks of a PR; `overall` reads "pending" while workflow runs wait for approval at that head (see overallAt). */
export async function checksOf(db: Db, repo: string, number: number): Promise<StoredChecks | undefined> {
  return (await checksOfAll(db, [{ repo, number }])).get(`${repo}#${number}`);
}

export type StoredChecks = { head_oid: string; overall: Overall; mergeable: string | null; maintainer_can_modify: number | null };

/** checksOf for many PRs, by `repo#number`, in two waves whatever their number; a PR without stored checks has no entry. */
export async function checksOfAll(db: Db, refs: readonly { repo: string; number: number }[]): Promise<Map<string, StoredChecks>> {
  if (!refs.length) return new Map();
  const rows = await loadChecks(db, [...refs]);
  const found = refs.flatMap((ref) => { const r = rows.get(`${ref.repo}#${ref.number}`); return r ? [{ ...ref, r }] : []; });
  const overall = await overallsAt(db, found.map(({ repo, number, r }) => ({ repo, number, head: r.head_oid, overall: r.overall })));
  return new Map(found.map(({ repo, number, r }) => [`${repo}#${number}`, { head_oid: r.head_oid, overall: overall.get(`${repo}#${number}`) as Overall, mergeable: r.mergeable, maintainer_can_modify: r.maintainer_can_modify }]));
}
