// reads: planner.item_plans, mirror.items
// reads: workflow.item_workflows, workflow.workflow_actions
// The maintainer Home: live workflows with their item titles, what the pipeline stopped, health, findings the fix gave up on and the Task Runner line.
import type { Db } from "../../db/index.ts";
import { inList } from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import * as mirror from "../mirror/index.ts";
import * as runners from "../runners/index.ts";
import * as security from "../security/index.ts";
import * as workflow from "../workflow/index.ts";
import { hiddenRepos } from "../control/fragments.ts";
import { planCifixIs } from "../planner/fragments.ts";
import { loadFailedJobs } from "./attention.ts";
import { loadHealthFacts, type HealthOptions } from "./health.ts";
import { loadStopped } from "./stopped.ts";
import type { FailedClose, HomeFacts, Scope } from "./types.ts";
import type { StageDefaults } from "../control/types.ts";

export type HomeOptions = { nowMs: number; withRunner: boolean; health: HealthOptions; limits: { steps: readonly string[]; defaults: StageDefaults } };

const NONE = () => new Set<never>();

export async function loadMaintainHome(db: Db, scope: Pick<Scope, "repos" | "hidden" | "staff" | "login">, o: HomeOptions): Promise<HomeFacts> {
  const q = queryDb(db);
  // The health read opens its own wave, so it runs beside this one.
  const [health, [live, stops, attention, ciFixFailed, failedJobs, snapshot, closesFailed]] = await Promise.all([loadHealthFacts(db, o.nowMs, o.health), db.together(() => Promise.all([
    workflow.listWorkflows(db, { live: true, repos: scope.repos }),
    loadStopped(db, scope, o.limits),
    scope.staff ? security.loadFindingAttention(db, { hide: scope.hidden, oldest: 0 }) : Promise.resolve(null),
    scope.staff ? q.all(q.k.selectFrom("item_plans as p").innerJoin("items as i", (j) => j.onRef("i.repo", "=", "p.repo").onRef("i.number", "=", "p.number"))
      .select(["p.repo", "p.number", "i.title"]).where("i.state", "=", "OPEN").where((eb) => planCifixIs(db, eb, "p", "cifix-failed"))
      .where(hiddenRepos(db, "i.repo", scope.hidden)).orderBy("p.planned_at", "desc").orderBy("p.repo").orderBy("p.number").limit(20)) : Promise.resolve([]),
    loadFailedJobs(db, scope, o.nowMs),
    o.withRunner && scope.login ? runners.loadRunnerSnapshot(db, o.nowMs) : Promise.resolve(null),
    scope.staff ? loadFailedCloses(db, scope.repos) : Promise.resolve([]),
  ]))]);
  const refs = live.map((w) => ({ repo: w.repo, number: w.number }));
  const [items, last, mine] = await db.together(() => Promise.all([
    mirror.loadItems(db, refs, "card"),
    workflow.loadLastEventKinds(db, refs),
    o.withRunner && scope.login ? runners.loadHelpers(db, [scope.login], o.nowMs) : Promise.resolve(null),
  ]));
  return {
    rows: live.map((w) => {
      const key = `${w.repo}#${w.number}`;
      return { ...w, title: items.get(key)?.title ?? null, author: items.get(key)?.author ?? null, lastEvent: last.get(key) ?? null };
    }),
    attention: { stops, health, gaveUp: attention?.gaveUp.flatMap((g) => (g.last_failure === null ? [] : [g])) ?? [], ciFixFailed: ciFixFailed as { repo: string; number: number; title: string }[], closesFailed, failedJobs },
    runner: snapshot && mine ? { mine: mine.get(scope.login!.toLowerCase()) ?? [], ready: runners.readyRunnersOf(snapshot, NONE as never) } : null,
  };
}

/** The closes people commanded that did not go through (or wait for the person's write access), while the item is open and no newer workflow took it up. 1 statement. */
async function loadFailedCloses(db: Db, repos: string[]): Promise<FailedClose[]> {
  if (!repos.length) return [];
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.workflow_actions as a").innerJoin("main.item_workflows as w", "w.id", "a.workflow_id")
    .innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "a.repo").onRef("i.number", "=", "a.number"))
    .select(["a.repo", "a.number", "a.by", "a.state", "a.reason"])
    .where("a.kind", "in", ["close", "comment-close"]).where("a.state", "in", ["failed", "skipped", "stopped", "waiting-permission"]).where("w.state", "=", "closed").where("i.state", "=", "OPEN")
    .where(inList(db, "a.repo", repos))
    .where((eb) => eb.not(eb.exists(eb.selectFrom("main.item_workflows as n").select(eb.lit(1).as("one")).whereRef("n.repo", "=", "w.repo").whereRef("n.number", "=", "w.number").whereRef("n.id", ">", "w.id"))))
    .orderBy("a.updated_at", "desc").orderBy("a.id", "desc").limit(20));
  return rows.map((r) => ({ ...r, number: Number(r.number) }));
}
