// Who an item's open question goes to: the people who started the workflow and approved it for merge, and on a row the automatic merge
// rule started, the person whose answer took it over (`takenBy`). Only they see it as theirs (Home, the rail badge, Discord alerts, the
// agent's own items); anyone with write access may still answer it. A rule row nobody took over asks nobody: it has no open question,
// and its state line says why it stopped and what AutoCraft would do (status.ts stateLine). A person's answer runs and takes it over.
import { openRecommendation, RULE_STARTER, type ItemWorkflow, type Recommendation } from "./types.ts";

/** The parts of a workflow that say who it asks; `takenBy` left out reads as nobody took it over. */
type Askers = Pick<ItemWorkflow, "startedBy" | "approvedBy"> & { takenBy?: string | null };

/** The logins a workflow's question goes to, in the order started, approved, took over; empty for a rule row nobody took over. */
export function askedLogins(wf: Askers): string[] {
  const out: string[] = [];
  for (const login of [wf.startedBy, wf.approvedBy, wf.takenBy ?? null]) {
    if (login && login !== RULE_STARTER && !out.some((o) => o.toLowerCase() === login.toLowerCase())) out.push(login);
  }
  return out;
}

/** A row the automatic merge rule started that no person approved or took over: it asks nobody. */
export const asksNobody = (wf: Askers): boolean => askedLogins(wf).length === 0;

/** The question the workflow asks and who it goes to; null when no recommendation is open or the row asks nobody. */
export function openQuestion(wf: (Pick<ItemWorkflow, "state" | "rec"> & Askers) | null): { rec: Recommendation; to: string[] } | null {
  const rec = openRecommendation(wf);
  const to = wf ? askedLogins(wf) : [];
  return rec && to.length ? { rec, to } : null;
}

/** `login` is one of the people the workflow's open question goes to. */
export const isAsked = (wf: Pick<ItemWorkflow, "state" | "rec"> & Askers, login: string): boolean =>
  openQuestion(wf)?.to.some((l) => l.toLowerCase() === login.toLowerCase()) ?? false;
