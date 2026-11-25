// Decide stage: open items that need a maintainer's scope call become
// dashboard decisions; the prepare step (prepare.ts) then gives every open decision a summary, a pick and drafted answers.
//
// runDecide() is the step the runner registers; `autocraft-server decide` runs it
// from a shell. Idempotent: items with a decision or a later stage are
// skipped, so a re-run or an interrupted run asks only what is still missing.
import { jobItem } from "../runner/job-items.ts";
import type { Item } from "../classify/parse.ts";
import { loadItems } from "../classify/run.ts";
import { trackedNames } from "../repos.ts";
import { buildDecision } from "./decision.ts";
import { ask } from "../decisions.ts";
import { takersFirst } from "../agents/call.ts";
import { decisionRefs, prepare, prepareIds } from "./prepare.ts";
import { type Candidate, type Reason } from "./select.ts";
import { latestRun, settledSet } from "../classify/settled.ts";
import { scopeReason } from "../core/decide-item.ts";
import { unsettledScope } from "../review/candidates.ts";
import { setAsideLapsedScope } from "../merge/withdraw.ts";
import { plannedItems } from "../core/select-items.ts";
import { ownLogins } from "../github/identity.ts";
import { isBotLogin } from "../review/bots.ts";
import { mapSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";

export type DecideParams = {
  /** Repo names; empty or missing means every tracked repo. */
  repos?: string[];
  /** Most decisions to create in this run. */
  limit?: number;
  dryRun?: boolean;
  /** Classification run; default the one with the newest Jev verdict. */
  run?: string;
  /** Called with the running count of items sent to the model. */
  onSent?: (n: number) => void;
  /** Read-only checkout for the prepare call (a PR's head, else the default branch), or null to ask without tools. Default: fetched from GitHub. */
  checkout?: (repo: string, number: number, head: string | null) => Promise<string | null>;
  /** PR diffs for the prepare call and the conversation's item block. Default: the diff cache or GitHub. */
  diff?: (repo: string, number: number, head: string) => Promise<string | null>;
};

/** Most new decisions, and most prepare calls, per run when no limit is given. */
const DEFAULT_LIMIT = 50;

export type RepoCount = { candidates: number; needsDecision: number; scopeDisagreement: number; asked: number };
export type DecideResult = { run: string | null; dryRun: boolean; byRepo: Record<string, RepoCount>; asked: number; prepared: number; usageRun: string | null };

export type Log = (line: string) => void;

const now = () => new Date().toISOString();

/** Items with their GitHub labels and first non-bot comments, for the summary prompt. */
export async function loadSummaryItems(db: Db, refs: { repo: string; number: number }[]): Promise<Item[]> {
  // The mirror stores bot logins without `[bot]`: drop our own logins and known bots by name.
  const own = await ownLogins(db, "");
  return await mapSeq((await loadItems(db, refs)), async (i) => {
    let l: unknown = [];
    try { l = JSON.parse((await db.get(db.k.selectFrom("items").select("labels").where("repo", "=", i.repo).where("number", "=", i.number)))!.labels ?? "[]"); } catch { /* none */ }
    return {
      ...i, labels: Array.isArray(l) ? l.filter((x): x is string => typeof x === "string") : [],
      comments: (await db.all(db.k.selectFrom("comments").select(["author", "body"]).$narrowType<{ body: string }>().where("repo", "=", i.repo).where("number", "=", i.number)
        .where((eb) => eb(eb.fn.coalesce(eb.fn("trim", ["body"]), eb.val("")), "<>", "")).orderBy("created_at", (o) => o.asc().nullsFirst()).limit(100))).filter((x) => !x.author || (!own.has(x.author) && !isBotLogin(x.author))).slice(0, 3),
    };
  });
}

function count(byRepo: Record<string, RepoCount>, repo: string): RepoCount {
  return (byRepo[repo] ??= { candidates: 0, needsDecision: 0, scopeDisagreement: 0, asked: 0 });
}

export async function runDecide(db: Db, params: DecideParams = {}, log: Log = console.log): Promise<DecideResult> {
  if (params.limit !== undefined && !(Number.isInteger(params.limit) && params.limit >= 0)) throw new Error("limit must be a whole number ≥ 0");
  const total = params.limit ?? DEFAULT_LIMIT;
  const tracked = new Set(await trackedNames(db));
  const untracked = (params.repos ?? []).filter((r) => !tracked.has(r));
  if (untracked.length) throw new Error(`not tracked: ${untracked.join(", ")}`);
  const run = params.run ?? await latestRun(db);
  const result: DecideResult = { run, dryRun: !!params.dryRun, byRepo: {}, asked: 0, prepared: 0, usageRun: null };
  const picked: Candidate[] = [];
  if (!run) log("decide: no classification run with Jev verdicts");
  else {
    const planned = (await plannedItems(db, "decide", { run, bucket: "new" })).filter((p) => !params.repos?.length || params.repos.includes(p.facts.repo));
    const lookup = await settledSet(db, run, planned.map((p) => `${p.facts.repo}#${p.facts.number}`));
    const all: Candidate[] = await mapSeq(planned, async (p) => ({ repo: p.facts.repo, number: p.facts.number, reason: scopeReason(p.facts)!, settled: await lookup(p.facts.repo, p.facts.number) }));
    picked.push(...all.slice(0, total));
    const reasonKey: Record<Reason, "needsDecision" | "scopeDisagreement"> = { "needs-decision": "needsDecision", "scope-disagreement": "scopeDisagreement" };
    for (const c of picked) {
      const n = count(result.byRepo, c.repo);
      n.candidates++;
      n[reasonKey[c.reason]]++;
    }
    log(`decide: run ${run}, ${all.length} items need a scope decision, ${picked.length} in this run${params.dryRun ? " (dry run)" : ""}`);
  }
  if (params.dryRun) return result;

  const usageRun = `decide-${now().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
  let sent = 0;
  // New decisions are asked first, without a model call; the prepare step below gives them (and every other open decision) its summary, pick and drafts.
  const at = now();
  const lapsed = await unsettledScope(db);
  for (const c of picked) {
    const q = await buildDecision(db, c);
    // A maintainer's answer that no longer counts is set aside, so a fresh question takes its id.
    if (lapsed.has(`${c.repo}#${c.number}`)) await setAsideLapsedScope(db, q.id, at);
    await ask(db, [{ ...q, asked_at: at }]);
    await db.run(db.k.insertInto("main.stages").values({ repo: c.repo, number: c.number, stage: "needs-decision", at, actor: "decide", note: `scope decision ${q.id}` }));
    count(result.byRepo, c.repo).asked++;
    await jobItem(db, c.repo, c.number, "asked a scope decision", log, q.id);
  }
  const due = await prepareIds(db, params.repos);
  const rowOf = due.length > total ? new Map((await db.all(db.k.selectFrom("decisions").select(["id", "repo", "number"]))).map((r) => [r.id, r])) : new Map<string, { repo: string | null; number: number | null }>();
  const ids = (due.length > total ? await takersFirst(db, due, (id) => { const r = rowOf.get(id)?.repo; return r ? [r] : undefined; }, (id) => decisionRefs(rowOf.get(id)), "decide.prepare") : due).slice(0, total);
  if (ids.length) {
    result.usageRun = usageRun;
    const r = await prepare(db, ids, {
      checkout: params.checkout ?? (async (repo, number, head) => {
        if (head) return import("../sandbox/index.ts").then((m) => m.checkoutForPr(repo, number, head, log));
        return import("../dupes/compare.ts").then((m) => m.baseCheckout(db, repo));
      }),
      diff: params.diff ?? ((r, n, h) => import("../conversations/run.ts").then((m) => m.githubDiff(db)(r, n, h))),
      usageRun, log, onSent: () => params.onSent?.(++sent),
    });
    result.prepared = r.stored;
  }
  for (const n of Object.values(result.byRepo)) result.asked += n.asked;
  log(`decide: asked ${result.asked} decisions; ${result.prepared} prepared`);
  return result;
}

function parseArgs(args: string[]): DecideParams {
  const p: DecideParams = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!, v = args[i + 1];
    if (a === "--dry-run") { p.dryRun = true; continue; }
    if (v === undefined || !["--repo", "--limit", "--run"].includes(a)) throw new Error(`unknown or incomplete option ${a}; usage: decide [--repo R ...] [--limit N] [--run ID] [--dry-run]`);
    i++;
    if (a === "--repo") (p.repos ??= []).push(v);
    else if (a === "--limit") p.limit = Number(v);
    else p.run = v;
  }
  return p;
}

function table(r: DecideResult): string {
  const rows = Object.entries(r.byRepo).sort(([a], [b]) => a.localeCompare(b));
  const head = r.dryRun ? "repo\tdecisions\tneeds decision\tscope disagreement" : "repo\tcandidates\tasked";
  return [head, ...rows.map(([repo, n]) => r.dryRun ? `${repo}\t${n.candidates}\t${n.needsDecision}\t${n.scopeDisagreement}` : `${repo}\t${n.candidates}\t${n.asked}`)].join("\n");
}

export const commands = {
  decide: {
    summary: `decide [--repo R ...] [--limit N] [--run ID] [--dry-run]: ask scope decisions and prepare every open decision`,
    async run(args: string[]): Promise<void> {
      const r = await runDecide(await openDb(), parseArgs(args), (l) => console.error(l));
      console.log(table(r));
    },
  },
};
