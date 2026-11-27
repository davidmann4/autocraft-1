// Group comparison: one call per set of same-kind members of a duplicate group.
// PRs go to Opus with read-only tools on a checkout of the base, issues to Sonnet
// without tools. A closed or merged member wins without a call; a set of more than
// GROUP_MAX members is compared in rounds whose winners meet. When the model gives
// no valid answer the canonical rule decides (source "rule"). Reads GitHub (live
// state, diffs); never writes to it.
//
//   autocraft-server dupe-compare [--limit N] [--dry-run]
import { jobItem } from "../runner/job-items.ts";
import { referenceDir } from "../reference.ts";
import { defaultSemanticDeps, type SemanticDeps } from "../reference-lint.ts";
import { poolRoom, takersFirst } from "../agents/call.ts";
import { runModelStep } from "../agents/step.ts";
import { COMPARE_ISSUES, COMPARE_PRS } from "../agents/steps.ts";
import { add, askClaude, pool, saveUsage, type Usage } from "../classify/run.ts";
import { ownerOf } from "../owners.ts";
import { Client, type Querier } from "../mirror.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { checksOfAll } from "../review/checks.ts";
import { cachedDiff, codeDiff, ghDiff, type DiffFetcher } from "../review/diff.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import type { Lint } from "../replylint.ts";
import { compareCanonical, canonInfo, canonInfoAll, pickCanonical, type CanonInfo } from "./canonical.ts";
import {
  GROUP_DIFF_CHARS, GROUP_MAX, prsRef, 
  type CompareIssue, type CompareIssues, type ComparePr, type ComparePrs,
} from "./group.ts";
import { dueSets, groupPlans, ruleOutcome, waitingGroups, type KindSet } from "./plan.ts";
import { loadItems, type ItemOf } from "../data/mirror/index.ts";
import { loadLatestReviews } from "../data/review/index.ts";
import { loadDupeGroups, loadDupeState, markComparisonsStale, saveComparisons, saveDrops, saveDupeGroups, type ComparisonPut } from "../data/triage/index.ts";
import { filterSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";

const PR_PROMPT = CLAUDE_PROMPTS["dupes.compare-prs.opus"];
const ISSUE_PROMPT = CLAUDE_PROMPTS["dupes.compare-issues.sonnet"];

/** Most sets compared per job unless the step's limit says otherwise. */
export const DEFAULT_LIMIT = 50;

export type Reply = { text: string; usage: Usage } | null;
export type CompareDeps = {
  /** Reads the live state and head of the members just before the model calls; absent: the mirror's view stands. */
  querier?: Querier;
  fetchDiff: DiffFetcher;
  /** Host directory with a read-only checkout of the base for a sandboxed call, or null to ask without tools. Absent: no tools. */
  baseCheckout?: (repo: string) => Promise<string | null>;
  /** `lint`: see AskOptions; a reply of the real `ask` may carry the lint's remaining problems and whether a fix turn ran. */
  ask(id: "dupes.compare-prs.opus", model: string, input: ComparePrs, checkout?: string, lint?: Lint): Promise<Reply>;
  ask(id: "dupes.compare-issues.sonnet", model: string, input: CompareIssues): Promise<Reply>;
  now(): Date;
  /** The semantic reference check of carry points; absent: the default (Jev, then Haiku). */
  semantic?: SemanticDeps;
};

export type CompareParams = { limit?: number; repo?: string; dryRun?: boolean; onHandled?: (n: number) => void };
export type CompareSummary = {
  due: number; compared: number; byRule: number; closedWins: number; single: number; dropped: number; dryRun: boolean;
};

type ComparisonResult = { others: { number: number; duplicate?: boolean; better?: string[]; carry?: string[]; adds?: string[]; via?: number }[]; rounds: number };

const sizeOf = (m: { additions: number | null; deletions: number | null }): number | null => (m.additions === null || m.deletions === null ? null : m.additions + m.deletions);

/** The row stored for a comparison of `set`: a PR set keeps the diff sizes and heads its members had when compared. */
function putOf(c: Omit<ComparisonPut, "sizes" | "heads" | "summary" | "why"> & Partial<Pick<ComparisonPut, "summary" | "why">>, set: KindSet): ComparisonPut {
  const sizes: Record<number, number> = {}, heads: Record<number, string> = {};
  if (c.kind === "pr") for (const m of set.members) { const z = sizeOf(m); if (z !== null) sizes[m.number] = z; if (m.head_oid) heads[m.number] = m.head_oid; }
  return { summary: null, why: null, ...c, sizes: c.kind === "pr" ? sizes : null, heads: c.kind === "pr" ? heads : null };
}

/** A read-only checkout of the repo's default branch at its current head, or null (no sandbox, no head, fetch failed). */
export async function baseCheckout(db: Db, repo: string): Promise<string | null> {
  const { branchOf, mainHeadOf } = await import("../github/fork.ts");
  const { checkoutForCommit } = await import("../sandbox/index.ts");
  const branch = await branchOf(db, repo);
  const sha = await mainHeadOf(repo, branch);
  return sha ? checkoutForCommit(repo, branch, sha, console.log) : null;
}

export function defaultCompareDeps(db: Db): CompareDeps {
  return {
    querier: new Client(500), fetchDiff: ghDiff,
    baseCheckout: (repo) => baseCheckout(db, repo),
    ask: ((id: "dupes.compare-prs.opus" | "dupes.compare-issues.sonnet", model: string, input: ComparePrs | CompareIssues, checkout?: string, lint?: Lint) =>
      askClaude(id, model, [input] as never, db, { checkout, reference: checkout ? referenceDir(input.ref.split("#")[0]!) : undefined, lint })) as CompareDeps["ask"],
    now: () => new Date(),
  };
}

export const liveQuery = (numbers: number[]) => `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {${numbers.map((n) => `
    i${n}: issueOrPullRequest(number: ${n}) { __typename ... on Issue { state } ... on PullRequest { state headRefOid } }`).join("")}
  }
}`;

/** Live state and head of the items; an item GitHub returned null for is left out. */
async function liveOf(q: Querier, repo: string, numbers: number[]): Promise<Map<number, { state: string; head: string | null }>> {
  const out = new Map<number, { state: string; head: string | null }>();
  const data = await q.query(liveQuery(numbers), { owner: ownerOf(repo), name: repo }) as { repository?: Record<string, { state?: string; headRefOid?: string } | null> };
  for (const n of numbers) {
    const x = data.repository?.[`i${n}`];
    if (x?.state) out.set(n, { state: x.state, head: x.headRefOid ?? null });
  }
  return out;
}

const NOW_ISO = (d: CompareDeps) => d.now().toISOString();

async function viaRule(db: Db, s: KindSet, at: string, error: string | null, source: "rule" | "closed" | "single", known?: Map<string, CanonInfo>): Promise<ComparisonPut> {
  const numbers = s.members.map((m) => m.number);
  const c = await pickCanonical(db, s.repo, numbers, known);
  const others = numbers.filter((n) => n !== c.number).map((number) => (s.kind === "pr" ? { number, duplicate: true, better: [], carry: [] } : { number, adds: [] }));
  const reason = source === "closed" ? c.why : source === "single" ? "the only one" : `kept by rule: ${c.why}`;
  return putOf({ repo: s.repo, key: s.key, kind: s.kind, members: numbers, hash: s.hash, kept: c.number, source, model: null, reason, result: { others, rounds: 0 }, error, attempts: 0, at }, s);
}

type Ctx = {
  db: Db; deps: CompareDeps; log: (l: string) => void; checkouts: Map<string, Promise<string | null>>; runId: string;
  /** The members of the sets to compare, read once. */
  items: Map<string, ItemOf<"text">>;
  reviews: Awaited<ReturnType<typeof loadLatestReviews>>;
  canon: Map<string, CanonInfo>;
};

const bodyOf = (x: Ctx, repo: string, n: number) => {
  const it = x.items.get(`${repo}#${n}`);
  if (!it) throw new Error(`${repo}#${n} is not in the database`);
  return it;
};

async function prInput(x: Ctx, repo: string, numbers: number[]): Promise<ComparePrs> {
  const share = Math.floor(GROUP_DIFF_CHARS / numbers.length);
  // Read just before the call, for all members at once: CI may have moved while the job waited for a Task Runner.
  const ci = await checksOfAll(x.db, numbers.filter((n) => bodyOf(x, repo, n).head_oid).map((number) => ({ repo, number })));
  const prs: ComparePr[] = [];
  for (const n of numbers) {
    const it = bodyOf(x, repo, n);
    let diff = "", files: string[] = [];
    if (it.head_oid) {
      const d = await cachedDiff(x.db, repo, n, it.head_oid, x.deps.fetchDiff);
      if (d.ok) {
        let cd = codeDiff(d.text);
        if (!cd.files.length && cd.testsOmitted.length) cd = codeDiff(d.text, true);
        files = cd.files;
        diff = cd.text.length > share ? `${cd.text.slice(0, share)}\n[diff cut]` : cd.text;
      } else diff = `[diff unavailable: ${d.error}]`;
    }
    const checks = it.head_oid ? ci.get(`${repo}#${n}`) : undefined;
    const latest = x.reviews.get(`${repo}#${n}`);
    const review = it.head_oid && latest?.head === it.head_oid ? latest.verdict : null;
    let linked: number[] = [];
    try { const v = JSON.parse(it.closing_issues ?? "[]") as unknown; if (Array.isArray(v)) linked = v.filter((k): k is number => typeof k === "number"); } catch { /* none */ }
    prs.push({
      ref: `#${n}`, title: it.title ?? "", body: it.body ?? "", state: it.state.toLowerCase(), author_association: it.author_association,
      linked_issues: linked.map((k) => `#${k}`), ci: checks?.head_oid === it.head_oid ? checks.overall : "unknown", review, files, diff,
    });
  }
  return { ref: prsRef(repo, numbers), prs };
}

function issueInput(x: Ctx, repo: string, numbers: number[]): CompareIssues {
  const issues: CompareIssue[] = numbers.map((n) => {
    const it = bodyOf(x, repo, n);
    return { ref: `#${n}`, title: it.title ?? "", body: it.body ?? "", state: it.state.toLowerCase(), author_association: it.author_association, comments: it.comments_count ?? 0 };
  });
  return { ref: prsRef(repo, numbers), issues };
}

type Chunk = { keep: number; reason: string; summary: string | null; why: string | null; others: ComparisonResult["others"] };

/** One call for up to GROUP_MAX members; null when the model gave no valid answer. */
/** `usage.ran`: the model id that answered, when the harness reported one (user-local calls). */
async function compareChunk(x: Ctx, s: KindSet, numbers: number[], usage: { u: Usage; model: string; ran?: string }): Promise<Chunk | null> {
  const { deps } = x;
  if (s.kind === "pr") {
    const input = await prInput(x, s.repo, numbers);
    let checkout: string | null = null;
    if (deps.baseCheckout) {
      if (!x.checkouts.has(s.repo)) x.checkouts.set(s.repo, deps.baseCheckout(s.repo).catch(() => null));
      checkout = await x.checkouts.get(s.repo)!;
    }
    if (checkout) input.repo_dir = REPO_PATH;
    const model = PR_PROMPT.models[0]!;
    usage.model = model;
    // Carry points reach the close comment and the kept PR's suggestion: they get the reference checks of posted text.
    const dir = referenceDir(s.repo);
    const semantic = dir ? deps.semantic ?? defaultSemanticDeps(x.db, input.ref) : undefined;
    const r = await runModelStep(x.db, COMPARE_PRS, { numbers, input }, { ctx: { dir, semantic }, ask: (i, lint) => deps.ask("dupes.compare-prs.opus", model, i.input, checkout ?? undefined, lint) });
    usage.u = add(usage.u, r.usage);
    if (r.ok && r.model) usage.ran = r.model;
    return r.ok ? r.value : null;
  }
  const input = issueInput(x, s.repo, numbers);
  const model = ISSUE_PROMPT.models[0]!;
  usage.model = model;
  const r = await runModelStep(x.db, COMPARE_ISSUES, { numbers, input }, { ask: (i) => deps.ask("dupes.compare-issues.sonnet", model, i.input) });
  usage.u = add(usage.u, r.usage);
  if (r.ok && r.model) usage.ran = r.model;
  return r.ok ? r.value : null;
}

/**
 * The items a set's calls name, for the runners that take only some items: every member when one call compares them all; none for
 * a set compared in rounds, whose later calls name only some members, so only runners that take every item count for it.
 */
const setRefs = (s: KindSet): { repo: string; number: number }[] => (s.members.length <= GROUP_MAX ? s.members.map((m) => ({ repo: s.repo, number: m.number })) : []);

/** Compares the whole set, in rounds when it is larger than GROUP_MAX. */
async function compareSet(x: Ctx, s: KindSet): Promise<ComparisonPut> {
  const at = NOW_ISO(x.deps);
  // Best by rule first, so every chunk holds a mix of strong and weak members and the rule's pick reaches the last round.
  const infos = (await canonInfo(x.db, s.repo, s.members.map((m) => m.number), x.canon)).sort(compareCanonical);
  let current = infos.map((i) => i.number);
  const usage: { u: Usage; model: string; ran?: string } = { u: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }, model: "" };
  const start = at;
  const lost = new Map<number, { winner: number; other: ComparisonResult["others"][number] }>();
  let rounds = 0, last: Chunk | null = null;
  for (;;) {
    // Dealt round-robin, so every chunk holds a mix of strong and weak members.
    const count = Math.ceil(current.length / GROUP_MAX);
    const chunks: number[][] = Array.from({ length: count }, () => []);
    current.forEach((n, i) => chunks[i % count]!.push(n));
    const winners: number[] = [];
    for (const chunk of chunks) {
      if (chunk.length === 1) { winners.push(chunk[0]!); continue; }
      const r = await compareChunk(x, s, chunk, usage);
      if (!r) {
        await saveUsage(x.db, x.runId, `dupes-compare-${s.key.replace(/[^A-Za-z0-9]/g, "-")}`, "dupes", usage.model, 0, usage.u, start, NOW_ISO(x.deps));
        return await viaRule(x.db, s, at, "no valid answer from the model", "rule", x.canon);
      }
      winners.push(r.keep);
      last = r;
      for (const o of r.others) lost.set(o.number, { winner: r.keep, other: o });
    }
    rounds++;
    current = winners;
    if (chunks.length === 1) break;
  }
  const kept = current[0]!;
  await saveUsage(x.db, x.runId, `dupes-compare-${s.key.replace(/[^A-Za-z0-9]/g, "-")}`, "dupes", usage.model, s.members.length, usage.u, start, NOW_ISO(x.deps));
  const others = s.members.map((m) => m.number).filter((n) => n !== kept).sort((a, b) => a - b).map((n) => {
    const l = lost.get(n)!;
    return { ...l.other, ...(l.winner !== kept ? { via: l.winner } : {}) };
  });
  return putOf({
    repo: s.repo, key: s.key, kind: s.kind, members: s.members.map((m) => m.number), hash: s.hash, kept, source: "model", model: usage.ran ?? usage.model,
    reason: last?.reason ?? null, summary: last?.summary ?? null, why: last?.why ?? null, result: { others, rounds }, error: null, attempts: 0, at,
  }, s);
}

export async function runDupeCompare(db: Db, params: CompareParams = {}, log: (line: string) => void = console.log, deps?: CompareDeps): Promise<CompareSummary> {
  if (params.limit !== undefined && !(Number.isInteger(params.limit) && params.limit >= 0)) throw new Error("limit must be a whole number ≥ 0");
  const d = deps ?? defaultCompareDeps(db);
  const s: CompareSummary = { due: 0, compared: 0, byRule: 0, closedWins: 0, single: 0, dropped: 0, dryRun: !!params.dryRun };
  const state = await loadDupeState(db, { repo: params.repo });
  const sets = dueSets(state, d.now().getTime()).sets;
  s.due = sets.length;
  if (params.dryRun) {
    log(`dupe-compare: ${sets.length} sets to compare; dry run, nothing written`);
    return s;
  }
  const runId = `dupe-compare-${d.now().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
  const refs = [...new Map(sets.flatMap((set) => set.members.map((m) => [`${set.repo}#${m.number}`, { repo: set.repo, number: m.number }] as const))).values()];
  const [items, reviews, canon] = await db.together(() => Promise.all([loadItems(db, refs, "text"), loadLatestReviews(db, refs), canonInfoAll(db, refs)]));
  const x: Ctx = { db, deps: d, log, checkouts: new Map(), runId, items, reviews, canon };
  let calls: KindSet[] = [];
  const settled: ComparisonPut[] = [];
  for (const set of sets) {
    const at = NOW_ISO(d);
    const rule = ruleOutcome(set);
    if (rule === "closed") {
      settled.push(await viaRule(db, set, at, null, "closed", canon));
      s.closedWins++;
    } else if (rule === "single") {
      settled.push(await viaRule(db, set, at, null, "single", canon));
      s.single++;
    } else calls.push(set);
  }
  await saveComparisons(db, settled);
  if (d.querier && calls.length) {
    // The mirror can be minutes behind: a set with a member closed or pushed since is compared on a later pass.
    const live = new Map<string, Map<number, { state: string; head: string | null }>>();
    try {
      for (const repo of new Set(calls.map((c) => c.repo))) live.set(repo, await liveOf(d.querier, repo, [...new Set(calls.filter((c) => c.repo === repo).flatMap((c) => c.members.map((m) => m.number)))]));
    } catch (e) {
      log(`dupe-compare: live state unavailable (${String((e as Error).message ?? e)}); nothing asked`);
      calls = [];
    }
    const asked = calls.length;
    const drops: { repo: string; key: string; hash: string; at: string }[] = [];
    calls = await filterSeq(calls, async (c) => {
      const l = live.get(c.repo)!;
      const bad = c.members.find((m) => { const v = l.get(m.number); return !v || v.state !== m.state || (m.kind === "pr" && v.head !== m.head_oid); });
      if (bad) {
        await jobItem(db, c.repo, bad.number, `dropped from duplicate set ${c.key}, it changed on GitHub since the last sync`, log);
        drops.push({ repo: c.repo, key: c.key, hash: c.hash, at: NOW_ISO(d) });
      }
      return !bad;
    });
    await saveDrops(db, drops);
    s.dropped = asked - calls.length;
  }
  if (params.limit !== undefined) calls = (await takersFirst(db, calls, (c) => [c.repo], setRefs, ISSUE_PROMPT.id)).slice(0, params.limit);
  let handled = 0;
  await pool(calls.map((set) => async () => {
    const r = await compareSet(x, set);
    if (r.source === "rule") {
      const prev = state.comparisons.get(`${set.repo}\n${set.key}`);
      r.attempts = (prev && prev.source === "rule" && prev.hash === set.hash ? prev.attempts : 0) + 1;
    }
    await saveComparisons(db, [r]);
    if (r.source === "rule") {
      s.byRule++;
      log(`  ${set.repo} ${set.key}: no valid answer; kept #${r.kept} by rule`);
    } else s.compared++;
    for (const m of set.members) await jobItem(db, set.repo, m.number, `compared in duplicate set ${set.key}, keep #${r.kept}${r.source === "rule" ? " (by rule)" : ""}`, () => {});
    params.onHandled?.(++handled);
  }), poolRoom(db, (i) => [calls[i]!.repo], (i) => setRefs(calls[i]!), { promptId: ISSUE_PROMPT.id }));
  // The groups with all their comparisons current, and the role of each member: the signal the other stages read.
  const [after, stored] = await db.together(() => Promise.all([loadDupeState(db, { repo: params.repo }), loadDupeGroups(db, { repo: params.repo })]));
  const plans = groupPlans(after);
  const groups = [...plans, ...waitingGroups(after, stored)];
  for (const repo of new Set([...after.edges, ...stored].map((e) => e.repo))) await saveDupeGroups(db, repo, groups.filter((g) => g.repo === repo));
  log(`dupe-compare: ${s.compared} compared by a model, ${s.byRule} by rule, ${s.closedWins} won by a closed member, ${s.single} single, ${s.dropped} dropped; ${plans.length} groups`);
  return s;
}

function parseArgs(args: string[]): CompareParams {
  const p: CompareParams = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--dry-run") p.dryRun = true;
    else if (a === "--limit" && args[i + 1] !== undefined) p.limit = Number(args[++i]);
    else throw new Error(`unknown or incomplete option ${a}; usage: dupe-compare [--limit N] [--dry-run]`);
  }
  return p;
}

/** Makes the stored comparisons that include the item not current, so the next dupe-compare step compares their sets again. Returns how many it marked. */
export async function compareAgain(db: Db, by: string, repo: string, number: number): Promise<number> {
  return await markComparisonsStale(db, repo, number, by);
}

export const commands = {
  "dupe-compare": {
    summary: "dupe-compare [--limit N] [--dry-run] | again REPO#N [--by LOGIN]: compare each duplicate group in one pass (Opus for PRs, Sonnet for issues) and again compares the sets that include the item once more",
    async run(args: string[]): Promise<void> {
      const db = await openDb();
      if (args[0] === "again") {
        const m = /^([\w.-]+)#(\d+)$/.exec(args[1] ?? "");
        const by = args[2] === "--by" && args[3] ? args[3] : "cli";
        if (!m || args.length !== (args[2] ? 4 : 2)) throw new Error("usage: autocraft-server dupe-compare again <repo>#<number> [--by <login>]");
        const n = await compareAgain(db, by, m[1]!, Number(m[2]));
        console.log(n ? `${args[1]}: ${n} comparison${n === 1 ? "" : "s"} marked; the next dupe-compare step compares again` : `${args[1]}: no stored comparison includes it`);
        return;
      }
      console.log(JSON.stringify(await runDupeCompare(db, parseArgs(args), (l) => console.error(l))));
    },
  },
};
