// Repo step approvals (M06 control-b).
import type { SelectQueryBuilder } from "kysely";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import { repoInScope } from "../../core/scope.ts";
import { repoScopeCols, repoScopeOf } from "../workflow/scope.ts";
import { addAudit } from "./audit.ts";
import { SETTINGS } from "./settings.ts";
import type { RepoGuard, RepoNeed, Step, StepApproval, StepApprovals } from "./types.ts";

const STEPS: readonly Step[] = ["merge", "push", "comment", "fixissue", "labels", "mainfix", "prstatus", "ci"];

type RepoKeys = string[] | KeySource;

/** The distinct repos a key set names, as a one-column select. A list of names is bound as one JSON parameter. */
function repoSet(db: Db, repos: RepoKeys): SelectQueryBuilder<any, any, { repo: string }> {
  const k = queryDb(db).k as any;
  const names = repos as unknown[];
  if (Array.isArray(repos) && (!names.length || typeof names[0] === "string")) return k.selectFrom(kx.valuesTable(db, [...new Set(names as string[])].map((repo) => ({ repo })), { repo: "text" }, "rk")).select("rk.repo");
  return k.selectFrom(resolveKeys(db, repos as KeySource, "kk")).select("kk.repo").distinct();
}

const isEmpty = (repos: RepoKeys): boolean => Array.isArray(repos) && repos.length === 0;

const approvalRows = (db: Db, repos: RepoKeys | "all", steps: readonly Step[] | undefined) => {
  const q = queryDb(db);
  return q.all(q.k.selectFrom("main.repo_step_approvals").select(["repo", "step", "by", "at"])
    .$if(repos !== "all", (b) => b.where("repo", "in", repoSet(db, repos as RepoKeys)))
    .$if(!!steps, (b) => b.where(kx.inList(db, "step", [...steps!]))).orderBy("repo").orderBy("step"));
};

function group(rows: Awaited<ReturnType<typeof approvalRows>>): Map<string, StepApprovals> {
  const out = new Map<string, StepApprovals>();
  for (const r of rows) {
    if (!(STEPS as readonly string[]).includes(r.step)) continue;
    const cur = out.get(r.repo) ?? out.set(r.repo, {}).get(r.repo)!;
    cur[r.step as Step] = { by: r.by, at: r.at };
  }
  return out;
}

/**
 * Approval rows per repo, only for repos that have one. `"all"` reads every repo's rows (no repo filter), which is what
 * `loadControl` needs to load in the same wave as the tracked repos.
 */
export async function loadStepApprovals(db: Db, repos: RepoKeys | "all", steps?: Step[]): Promise<Map<string, StepApprovals>> {
  if (repos !== "all" && isEmpty(repos)) return new Map();
  if (steps && !steps.length) return new Map();
  return group(await approvalRows(db, repos, steps));
}

/** One repo and step; a one-line wrapper over `loadStepApprovals`. */
export async function repoStepApproval(db: Db, repo: string, step: Step): Promise<StepApproval | null> {
  return (await loadStepApprovals(db, [repo], [step])).get(repo)?.[step] ?? null;
}

/**
 * The approvals and global switch a GitHub write is gated on, read now and never from the snapshot. `need` limits the approval
 * rows to one step (`"pipeline"` reads none). Every repo asked for has an entry. The switch counts as on while the pipeline
 * is on or draining, as the guard has always read it.
 */
export async function loadRepoGuards(db: Db, repos: RepoKeys, need?: RepoNeed): Promise<Map<string, RepoGuard>> {
  const out = new Map<string, RepoGuard>();
  if (isEmpty(repos)) return out;
  const q = queryDb(db);
  const [names, rows, sw] = await db.together(() => Promise.all([
    q.all(repoSet(db, repos) as SelectQueryBuilder<any, any, { repo: string }>),
    need === "pipeline" ? Promise.resolve([]) : approvalRows(db, repos, need ? [need] : undefined),
    q.get(q.k.selectFrom("main.settings").select("value").where("key", "=", "pipeline_enabled")),
  ]));
  const approvals = group(rows);
  const pipelineOn = SETTINGS.pipelineWrites.read(sw?.value ?? undefined) as boolean;
  for (const r of names) out.set(r.repo, { approvals: approvals.get(r.repo) ?? {}, pipelineOn });
  return out;
}

/**
 * Why Act cannot run for each repo, null when it can: the pipeline is off or draining, the repo is out of scope for cards
 * (src/core/scope.ts), or the Act limit is 0. `defaults` are the step
 * defaults of the daily limits, for an Act limit nobody set.
 */
export async function loadActBlocked(db: Db, repos: RepoKeys, defaults?: Record<string, number | null>): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (isEmpty(repos)) return out;
  const q = queryDb(db);
  const [rows, sw, act] = await db.together(() => Promise.all([
    q.all(q.k.selectFrom(repoSet(db, repos).as("rk")).leftJoin("main.tracked_repos as t", "t.name", "rk.repo")
      .select((eb) => ["rk.repo as repo", "t.name as tracked", ...repoScopeCols(eb, "t")])),
    q.get(q.k.selectFrom("main.settings").select("value").where("key", "=", "pipeline_enabled")),
    q.get(q.k.selectFrom("main.stage_limits").select(["per_day", "limit_set"]).where("step", "=", "act")),
  ]));
  const raw = sw?.value ?? undefined;
  const off = SETTINGS.pipelineEnabled.read(raw) ? null : SETTINGS.pipelineDraining.read(raw) ? "the pipeline is draining" : "the pipeline is off";
  const perDay = act && act.limit_set === 1 ? act.per_day : defaults?.act ?? null;
  for (const r of rows) {
    const inScope = repoInScope(r.tracked === null ? undefined : repoScopeOf(r), "cards");
    out.set(r.repo, off ?? (!inScope ? `the pipeline is off for ${r.repo}` : perDay === 0 ? "the daily limit of Act is 0" : null));
  }
  return out;
}

/**
 * The writer behind the dashboard buttons and CLI: throws for an untracked repo (approve or revoke), skips a row already at
 * that state, audits each change with `<step>-approve` or `<step>-revoke`; returns the number changed. A repeated
 * `(repo, step)` takes its last row.
 */
export async function setStepApproval(db: Db, rows: { repo: string; step: Step; on: boolean }[], by: string): Promise<number> {
  const want = new Map(rows.map((r) => [`${r.repo}\t${r.step}`, r]));
  if (!want.size) return 0;
  const q = queryDb(db);
  return await db.write(async () => {
    const repos = [...new Set([...want.values()].map((r) => r.repo))];
    const known = new Set((await q.all(q.k.selectFrom("main.tracked_repos").select("name").where(kx.inList(db, "name", repos)))).map((r) => r.name));
    for (const r of repos) if (!known.has(r)) throw new Error(`${r} is not tracked`);
    const at = new Date().toISOString();
    const on = [...want.values()].filter((r) => r.on), off = [...want.values()].filter((r) => !r.on);
    const changed = new Set<string>();
    if (on.length) {
      const ins = await q.all(q.k.insertInto("main.repo_step_approvals").values(on.map((r) => ({ repo: r.repo, step: r.step, by, at })))
        .onConflict((oc) => oc.columns(["repo", "step"]).doNothing()).returning(["repo", "step"]));
      for (const r of ins) changed.add(`${r.repo}\t${r.step}`);
    }
    if (off.length) {
      const del = await q.all(q.k.deleteFrom("main.repo_step_approvals").where(kx.tupleIn(db, ["repo", "step"], off.map((r) => [r.repo, r.step]), ["text", "text"])).returning(["repo", "step"]));
      for (const r of del) changed.add(`${r.repo}\t${r.step}`);
    }
    const audited = [...want].filter(([k]) => changed.has(k)).map(([, r]) => ({ login: by, action: `${r.step}-${r.on ? "approve" : "revoke"}`, target: r.repo, at }));
    await addAudit(db, audited);
    return audited.length;
  });
}
