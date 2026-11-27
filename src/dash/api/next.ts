// The Next page: per pipeline step, the items its next job will take, in the autopilot's own order (laneItems, stored by each planner pass), whether the step can run now, and the items waiting on something outside.
import type { NextItem, NextPage, NextStep, NextWaiting } from "../../../web/src/api/types.ts";
import { LANES, laneGates, stageStatus, storedLaneItems } from "../../runner/autopilot.ts";
import { lanesInOrder, STAGES } from "../../stages/registry.ts";
import { loadSteps } from "../../runner/steps.ts";
import * as control from "../../data/control/index.ts";
import * as planner from "../../data/planner/index.ts";
import type { Req } from "../types.ts";
import { shownMap } from "./shown.ts";
import { blankIfHidden, visibleRepos } from "./visible.ts";
import { readerOf, statusFor, veiledFor, type Reader } from "./reader.ts";
import type { Db } from "../../db/index.ts";

const WAITING_LIMIT = 500;

type View = { next?: string; scope?: boolean };
const viewOf = (p: { view: unknown } | undefined): View => (p?.view as View | null) ?? {};
const nextText = (p: { view: unknown } | undefined): string | null => viewOf(p).next ?? null;

/** `reader`: what the requester may read of the stored texts; without one (tests), every repo outside `visibleNames` is hidden. */
export async function nextPage(db: Db, visibleNames: string[], opts: { nowMs?: number; reader?: Reader } = {}): Promise<NextPage> {
  const visible = new Set(visibleNames), ms = opts.nowMs ?? Date.now();
  const reader = opts.reader ?? { staff: true, quiet: new Set<string>(), hidden: Object.assign([...(await control.loadTrackedRepos(db)).keys()].filter((r) => !visible.has(r)), { visible: visibleNames }) };
  const hidden = reader.hidden;
  const stepDefs = await loadSteps();
  const [stored, status, rows, gates] = await db.together(() => Promise.all([storedLaneItems(db), stageStatus(db), planner.listPlans(db, { hasWait: true }), laneGates(db, LANES, stepDefs, ms)]));
  const scoped = rows.filter((r) => visible.has(r.repo) && viewOf(r).scope);
  const wanted = Object.values(stored).flatMap((l) => (l?.items ?? []).filter((i) => visible.has(i.repo)).map((i) => ({ repo: i.repo, number: i.number })));
  const [plans, items] = await db.together(() => Promise.all([planner.loadPlans(db, wanted), shownMap(db, [...wanted, ...scoped.slice(0, WAITING_LIMIT)])]));
  const shown = (repo: string, number: number) => ({ ...(items.get(`${repo}#${number}`) ?? { kind: null, state: null, title: null }) });
  const why = (repo: string, number: number, action: string): string =>
    (veiledFor(reader, repo, number) ? null : blankIfHidden(nextText(plans.get(`${repo}#${number}`)), hidden) || null) ?? action;
  const stageOf = new Map(lanesInOrder().map((l) => [l.name, STAGES.find((s) => s.id === l.stage)?.title ?? l.stage]));
  const steps: NextStep[] = [];
  for (const lane of LANES) {
    const kept = stored[lane.name]?.items ?? [];
    const items: NextItem[] = kept.filter((i) => visible.has(i.repo)).map(({ refusal: _, ...i }) => ({ ...i, ...shown(i.repo, i.number), why: why(i.repo, i.number, i.action) }));
    const total = (stored[lane.name]?.total ?? 0) - (kept.length - items.length);
    const gate = gates.get(lane.name)!;
    const open = items.filter((i) => !i.blocked);
    // Every item blocked, by a breaker or a missing approval say: the step cannot do its work although it could start.
    const refused = !open.length && items.length ? items[0]!.blocked : null;
    const tripped = kept.find((i) => visible.has(i.repo))?.refusal === "breaker";
    steps.push({
      lane: lane.name, title: stepDefs.get(lane.steps?.[0] ?? lane.name)?.title ?? lane.name, stage: stageOf.get(lane.name) ?? "", steps: lane.steps ?? [],
      canRun: gate.canRun && !refused, kind: refused && gate.canRun ? (tripped ? "breaker" : "approval") : gate.kind, why: blankIfHidden(gate.why, hidden) || refused,
      note: blankIfHidden((lane.steps ?? []).map((s) => status[s]).find(Boolean) ?? null, hidden) || null, total, items,
    });
  }
  const waiting: NextWaiting[] = scoped.slice(0, WAITING_LIMIT).map((r) => {
    const s = statusFor(reader, r.repo, r.number, { waiting: r.wait, next: nextText(r) });
    return { repo: r.repo, number: r.number, ...shown(r.repo, r.number), wait: s.waiting ?? "", why: s.next };
  });
  return { steps, waiting, waitingTotal: scoped.length };
}

export async function next(db: Db, req: Req): Promise<NextPage> {
  const [visible, reader] = await Promise.all([visibleRepos(db, req), readerOf(db, req)]);
  return nextPage(db, visible, { reader });
}
