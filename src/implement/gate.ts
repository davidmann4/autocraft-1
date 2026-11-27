// What an implement job needs before it starts, checked again at the run: the repo's Implement feature (the workspaces it runs in), and
// a live implement workflow on the issue of someone who acts on the repo now (data/access standing): its newest answer, approval or start is the
// approval the implementation and its PR's revisions run on.
// A job that only ends an attempt whose PR merged or closed needs none of them.
import { featureOn } from "../build/features.ts";
import type { Db } from "../db/index.ts";
import { githubIdentity } from "../github/identity.ts";
import type { MayResult } from "../core/may.ts";
import { permKey, standings, type Standing } from "../data/access/index.ts";
import { loadImplementFacts } from "../data/implement/index.ts";
import { loadItems } from "../data/mirror/index.ts";
import { listWorkflows, loadAnswers, workflowActors } from "../data/workflow/index.ts";
import { settlerOf } from "../workflow/work.ts";
import { currentAttempt, writeStep } from "./attempt.ts";
import { ENDED_STATES } from "./types.ts";

type Ref = { repo: string; number: number };
type Actor = { login: string; standing: Standing };
const refOf = (r: Ref): `${string}#${number}` => `${r.repo}#${r.number}`;

/** Per issue (`repo#number`), who its live implement workflow acts for, newest first, each with whether they may act on the repo now; empty without one. */
async function actorsOf(db: Db, refs: Ref[]): Promise<Map<string, Actor[]>> {
  const [live, identity] = await db.together(() => Promise.all([listWorkflows(db, { live: true, refs }), githubIdentity(db)]));
  const first = new Map(live.toReversed().map((w) => [refOf(w), w]));
  const flows = [...first.values()].filter((w) => w.entry === "implement");
  const answers = await loadAnswers(db, flows.map((w) => w.id), { resumes: true });
  const logins = new Map(flows.map((w) => [refOf(w), workflowActors(w, answers.get(w.id))]));
  const at = await standings(db, flows.flatMap((w) => logins.get(refOf(w))!.map((login) => ({ login, repo: w.repo }))), { identity });
  return new Map(refs.map((r) => [refOf(r), (logins.get(refOf(r)) ?? []).map((login) => ({ login, standing: at.get(permKey(login, r.repo))! }))]));
}
const actorsOfIssue = async (db: Db, repo: string, number: number): Promise<Actor[]> => (await actorsOf(db, [{ repo, number }])).get(refOf({ repo, number }))!;

const settler = (actors: Actor[]) =>
  settlerOf(actors.map((a) => a.login), (login) => actors.find((a) => a.login === login)!.standing);

/** The login the issue's implementation runs for (settlerOf), or null when no implement workflow on it is live. */
export async function queuerOf(db: Db, repo: string, number: number): Promise<string | null> {
  return settler(await actorsOfIssue(db, repo, number))?.by ?? null;
}

/**
 * Whose Task Runner the attempt's model calls run on: `holder`'s (it keeps the sessions so far) while the live workflow acts for them and they may
 * act on the repo, else the one the implementation runs for now.
 */
async function turnsFor(db: Db, repo: string, number: number, holder: string): Promise<string> {
  const actors = await actorsOfIssue(db, repo, number);
  const held = actors.find((a) => a.login.toLowerCase() === holder.toLowerCase());
  if (held && held.standing !== "no") return holder;
  const s = settler(actors);
  return s?.standing === "yes" ? s.by : holder;
}

/** Moves the issue's attempt to the person its model calls run for now (turnsFor): the next turn starts a session on their Task Runner. */
export async function moveTurns(db: Db, repo: string, number: number): Promise<void> {
  const cur = await currentAttempt(db, repo, number);
  const to = cur && await turnsFor(db, repo, number, cur.impl.queuedBy);
  if (cur && to && to !== cur.impl.queuedBy) await writeStep(db, cur.impl, { patch: { queuedBy: to, sessionCallId: null } });
}

/** Whether the issue's implementation may write to the repo without its approval: as the person it runs for. */
export async function implementMay(db: Db, repo: string, number: number): Promise<MayResult> {
  const by = await queuerOf(db, repo, number);
  return by ? { ok: true, as: "person", by } : { ok: false, code: "not-approved", why: `${repo}#${number} is not queued` };
}

/** Why an implement job of the issue may not run, or null. `dry`: a dry run, which may run while the repo's Implement switch is off. */
export async function implementRefusal(db: Db, repo: string, number: number, o: { dry?: boolean } = {}): Promise<string | null> {
  return (await implementRefusals(db, [{ repo, number }], o)).get(refOf({ repo, number }))!;
}

/** implementRefusal of each issue, keyed `repo#number`, with reads whose number does not grow with the issues. */
export async function implementRefusals(db: Db, refs: Ref[], o: { dry?: boolean } = {}): Promise<Map<string, string | null>> {
  const repos = [...new Set(refs.map((r) => r.repo))];
  const [facts, actors, on] = await db.together(() => Promise.all([
    loadImplementFacts(db, refs), actorsOf(db, refs), Promise.all(repos.map((r) => (o.dry ? true : featureOn(db, "implement", r)))),
  ]));
  const off = new Set(repos.filter((_, i) => !on[i]));
  // A live attempt whose PR merged or closed only ends (attempt and workspace): bookkeeping that always runs.
  const prOf = new Map(refs.flatMap((r) => {
    const attempt = facts.byIssue.get(refOf(r))?.attempt;
    return !o.dry && attempt && !ENDED_STATES.has(attempt.state) && attempt.prNumber !== null ? [[refOf(r), { repo: r.repo, number: attempt.prNumber }] as const] : [];
  }));
  const prs = prOf.size ? await loadItems(db, [...prOf.values()], "ref") : new Map<string, { state: string }>();
  return new Map(refs.map((r) => {
    const ref = refOf(r), pr = prOf.get(ref) && prs.get(refOf(prOf.get(ref)!));
    if (pr && pr.state !== "OPEN") return [ref, null];
    if (off.has(r.repo)) return [ref, `Implement is off for ${r.repo}`];
    const s = settler(actors.get(ref)!);
    if (!s) return [ref, `${ref} is not queued`];
    return [ref, s.standing === "yes" ? null : s.standing === "no" ? `${s.by}, whom the work on ${ref} runs for, does not settle on ${r.repo}` : `GitHub has not answered on ${s.by}'s access to ${r.repo}`];
  }));
}
