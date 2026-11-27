// What the Home page shows about problems: what the pipeline stopped, what is unhealthy and what gave up. The facts come from
// src/data/views; this file words them.
import type { HomeProblem } from "../../../web/src/api/types.ts";
import { itemPath } from "../../../web/src/lib/links.ts";
import { parseTripKey } from "../../core/push-outcome.ts";
import { isHiddenRepo, type HiddenRepos } from "../../hidden-sql.ts";
import { loadSteps } from "../../runner/steps.ts";
import * as control from "../../data/control/index.ts";
import type { AttentionFacts } from "../../data/views/types.ts";
import { healthProblems, type ProblemFacts } from "./health.ts";
import { stepTitle } from "./trace.ts";
import type { Db } from "../../db/index.ts";

/** Something the pipeline stopped; `to` is the page where it goes on again. */
export type StoppedRow = { title: string; repo?: string; reason: string; to: string };

/** Tripped breakers, steps at a daily limit of 0 and authors held at their limit or by a surge. */
export async function stoppedRows(facts: AttentionFacts["stops"], hidden: HiddenRepos): Promise<StoppedRow[]> {
  const out: StoppedRow[] = [];
  for (const t of facts.trips) {
    const k = parseTripKey(t.stage);
    if (k && isHiddenRepo(hidden, k.repo)) continue;
    out.push({ title: stepTitle(k?.stage ?? t.stage), ...(k ? { repo: k.repo } : {}), reason: control.blankIfHidden(t.reason, hidden) ?? "", to: "/queue" });
  }
  const steps = await loadSteps();
  for (const l of facts.zeroLimits) out.push({ title: steps.get(l.step)?.title ?? l.step, reason: "The daily limit is 0", to: "/pipeline" });
  for (const g of facts.heldAuthors) {
    const issues = g.count - g.prs;
    const parts = [g.prs && `${g.prs} PR${g.prs === 1 ? "" : "s"}`, issues && `${issues} issue${issues === 1 ? "" : "s"}`].filter(Boolean).join(", ");
    out.push({ title: g.author, reason: `${parts} waiting for ${g.surge ? "the outside-surge breaker or " : ""}the author's daily limit`, to: "/items?filter=outside" });
  }
  return out;
}

/**
 * The problems list: the stopped rows first, then the instance's health problems, findings whose fix gave up and CI fixes that gave up, and closes that were not made
 * in the repos the reader acts on (`acting`).
 */
export async function problems(db: Db, o: Omit<ProblemFacts, "facts"> & { stops: StoppedRow[]; facts: AttentionFacts; acting: ReadonlySet<string> }): Promise<HomeProblem[]> {
  const { staff, facts } = o;
  const out: HomeProblem[] = [];
  for (const s of o.stops) out.push({ kind: "stopped", title: s.repo ? `${s.title} in ${s.repo}` : s.title, detail: staff ? s.reason : "", to: s.to });
  for (const p of (await healthProblems(db, o)).problems) out.push({ kind: p.area === "deadline" ? "stuck" : "health", title: p.text, detail: "", to: p.to });
  if (staff) {
    for (const f of facts.gaveUp)
      out.push({ kind: "gave-up", title: `${f.repo} finding ${f.number}: fix gave up after ${f.fix_attempts} round${f.fix_attempts === 1 ? "" : "s"}`, detail: f.last_failure ?? "", to: `/security/${f.repo}/${f.number}` });
    for (const r of facts.ciFixFailed)
      out.push({ kind: "gave-up", title: `${r.repo}#${r.number}: CI fix gave up`, detail: r.title ?? "", to: itemPath(r.repo, r.number) });
    for (const r of facts.closesFailed) {
      if (!o.acting.has(r.repo)) continue;
      out.push({ kind: "gave-up", title: `${r.repo}#${r.number}: not closed`, detail: r.state === "waiting-permission" ? `${r.by} has no write access` : r.reason ?? r.state, to: itemPath(r.repo, r.number) });
    }
  }
  return out;
}
