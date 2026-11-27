// Follow-up issues held until the merge. A card that merges the PR (a Merge answer, or a fix-up that merges: holdsIssues) does not open
// its issue at the press: it stores it here, and the Act step files it once the PR merged, whoever merged it. A PR closed without merging,
// or a merge path that ended (the Merge answer taken back, set aside or changed; the pre-approved merge cancelled, failed or handed back as
// a question), drops it; one on hold keeps it. The Act step reads these rows when the planner sees the PR's state or the merge path change: no timer runs.
//
// Filing writes the `filing` row before the call. A create whose answer was lost leaves that row behind: the issue may exist, so it is never
// filed again and the item page says the outcome is unknown. Only a refusal from GitHub (no issue can exist) returns the row to `held`.
import { guardRepo } from "../core/guard.ts";
import { loadActRoom, loadDueHeld, loadHeld, addHeld, addTurns, markHeld, type HeldInput, type HeldPatch, type HeldRow, type HeldState, type NewHeld } from "../data/conversations/index.ts";
import { exec as defaultExec, type Exec } from "../fixup/git.ts";
import { createIssue, IssueError, PACE_MAX_WAIT_MS, type Note, type Writer } from "../github/write.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { loadQuiet } from "../data/security/index.ts";
import { stillActs } from "../act/still.ts";
import type { RefreshDeps } from "../preapproval/permissions.ts";
import { roomFor } from "./queue.ts";
import { systemBlock } from "./store.ts";
import type { Db } from "../db/index.ts";

export type { HeldRow, HeldState, NewHeld };

/** Refusals from GitHub before the row stops being tried; each failed try ends the Act job as failed, so the registered failure backoff spaces them. */
export const HELD_MAX_ATTEMPTS = 3;

/** Held issues come from conversation cards, which always run on the conversation prompt's first model (as src/conversations/act.ts posts them). */
const NOTE: Note = { by: "operator", model: CLAUDE_PROMPTS["conversation.turn"].models[0] };
const ref = (repo: string, n: number) => `${repo}#${n}`;
const oneLine = (e: unknown): string => String((e as Error).message ?? e).replace(/\s+/g, " ").trim().slice(0, 300);

/** Stores the follow-up issue a card holds until the merge, bound to the workflow and merge approval the press ran under. Call it inside the press's write. */
export async function holdFollowup(db: Db, h: NewHeld): Promise<number> {
  return (await addHeld(db, [h]))[0]!;
}

/** The item's held follow-ups, oldest first. */
export const heldOf = async (db: Db, repo: string, n: number): Promise<HeldRow[]> => (await loadHeld(db, [`${repo}#${n}`])).get(`${repo}#${n}`) ?? [];

/**
 * What to do with a held row now: file it, drop it (with the reason), or keep holding (null). The row is bound to the workflow and merge
 * approval of its press (`h.path`, from `workflow.loadPathEnds`): a PR that merged files unless the path ended before the merge; a path
 * that was withdrawn or replaced, or a PR closed without merging, drops it; a held one goes on holding.
 */
export function heldVerdict(h: HeldInput): { file: true } | { drop: string } | null {
  if (!h.item) return null;
  if (h.item.state === "CLOSED") return { drop: "the PR was closed without merging" };
  const ended = h.path === "stopped" ? "the approved merge was withdrawn or replaced" : h.path === "closed" ? "the PR was closed without merging" : null;
  if (h.item.state !== "MERGED") return ended ? { drop: ended } : null;
  return ended ? { drop: ended } : { file: true };
}

/** A row left in `filing` past this was not being filed any more (a create takes seconds; the write pacing waits at most PACE_MAX_WAIT_MS). */
export const HELD_STUCK_MS = Math.max(10 * 60_000, 4 * PACE_MAX_WAIT_MS);

/**
 * What the audit row of a row left in `filing` tells: "filed" (with the issue) when the create finished with a URL, "held" when no create
 * was begun (nothing was sent), null when the row is not old enough to judge, or its create was begun and is not known to have opened an issue.
 */
export function filingOutcome(h: Pick<HeldInput, "state" | "updated_at" | "filingAudit">, ms: number = Date.now()): { state: "filed"; number: number; url: string } | { state: "held" } | null {
  if (h.state !== "filing" || Date.parse(h.updated_at) > ms - HELD_STUCK_MS) return null;
  if (!h.filingAudit) return { state: "held" };
  return h.filingAudit.issue ? { state: "filed", ...h.filingAudit.issue } : null;
}

/** The held rows of the PRs of `repo` (all repos without one) that the Act step has to file or drop now, from one `loadDueHeld`. */
export function dueOf(due: { rows: HeldInput[] }, ms: number): HeldInput[] {
  return due.rows.filter((h) => (h.state === "filing" ? filingOutcome(h, ms) !== null : heldVerdict(h) !== null));
}

export async function dueHeld(db: Db, repo?: string, ms: number = Date.now()): Promise<HeldInput[]> {
  return dueOf(await loadDueHeld(db, { ...(repo && { repo }), now: new Date(ms) }), ms);
}

/**
 * The repos whose Act job has held rows to file or drop now; `fits`: false when every one of them is to be filed and the daily count has
 * no room (the planner then wakes when room returns). Also the signature of that input for the planner.
 */
export async function heldDue(db: Db, ms: number = Date.now()): Promise<{ repos: Map<string, boolean>; sig: string }> {
  const [due, room] = await db.together(() => Promise.all([loadDueHeld(db, { now: new Date(ms) }), loadActRoom(db, new Date(ms))]));
  const fits = roomFor(room, 1);
  const repos = new Map<string, boolean>();
  for (const h of dueOf(due, ms)) {
    const v = h.state === "filing" ? null : heldVerdict(h);
    repos.set(h.repo, (repos.get(h.repo) ?? false) || fits || h.state === "filing" || (v !== null && "drop" in v));
  }
  return { repos, sig: repos.size ? `held:${[...repos].map(([r, f]) => `${r}=${f ? 1 : 0}`).join(",")}` : "" };
}

/** When rows in `filing` become old enough for filingOutcome to settle them: the planner wakes then. */
export async function filingWakes(db: Db, ms: number = Date.now()): Promise<number[]> {
  return (await loadDueHeld(db, { now: new Date(ms) })).rows.filter((h) => h.state === "filing").map((h) => Date.parse(h.updated_at) + HELD_STUCK_MS).filter((t) => t > ms);
}

/** The PR's thread line (when it has a conversation): what became of the held issue. */
const say = (h: Pick<HeldRow, "repo" | "number">, text: string) =>
  ({ ref: ref(h.repo, h.number), kind: "system" as const, login: "system", body: text, block: systemBlock(text), onlyIfThread: true });

/** Moves rows still in `from` and tells each thread (inside one write, so a thread line never outlives a move that lost). */
async function move(db: Db, moves: { h: HeldRow; from: HeldState; set: HeldPatch; say?: string }[]): Promise<Set<number>> {
  return await db.write(async () => {
    const done = await markHeld(db, moves.map((m) => ({ id: m.h.id, from: m.from, set: m.set })));
    const lines = moves.filter((m) => done.has(m.h.id) && m.say !== undefined).map((m) => say(m.h, m.say!));
    if (lines.length) await addTurns(db, lines);
    return done;
  });
}

const drop = async (db: Db, h: HeldRow, reason: string, at: string): Promise<boolean> =>
  (await move(db, [{ h, from: "held", set: { state: "dropped", reason, updated_at: at }, say: `The issue "${h.title}" held for after the merge is dropped: ${reason}.` }])).has(h.id);

export type HeldDeps = { exec?: Exec; now?: () => Date; /** Stands in for the GitHub App's read of the presser's write permission. */ permission?: RefreshDeps["permission"] };
/** `paced`: why a create sent nothing and may simply be tried again (IssueError.later): the job fails with it, as other paced jobs do. */
export type HeldSummary = { filed: number; dropped: number; failed: { ref: string; reason: string }[]; unknown: number; writes: number; paced?: string };

/**
 * Files or drops the due held follow-ups of the PRs of `repo`, oldest first. Each issue is one GitHub write of the Act step's shared daily
 * count (it goes out as a card write of the card that held it); the run stops at the first that finds no room, or past `writes` (what the
 * Act job still allows). A presser who no longer settles on the issue's repo, or a PR that turned quiet, drops the row; a missing approval
 * keeps it held with the reason. A create with an unknown outcome, or one the write pacing held back, ends the run. A row a stopped process left
 * in `filing` is settled from its audit row (filingOutcome). held_followups is not planner input, so these row writes never re-queue the job.
 */
export async function fileHeldFollowups(db: Db, repo: string, deps: HeldDeps = {}, o: { writes?: number } = {}): Promise<HeldSummary> {
  const s: HeldSummary = { filed: 0, dropped: 0, failed: [], unknown: 0, writes: 0 };
  const now = () => (deps.now?.() ?? new Date());
  for (const h of await dueHeld(db, repo, now().getTime())) {
    const at = now().toISOString();
    if (h.state === "filing") {
      // Left behind by a stopped process: its audit row says whether the create finished, or never went out.
      const f = filingOutcome(h, now().getTime());
      if (f?.state === "filed") { await markHeld(db, [{ id: h.id, from: "filing", set: { state: "filed", issue_number: f.number, url: f.url, reason: null, updated_at: at } }]); s.filed++; }
      else if (f?.state === "held") await markHeld(db, [{ id: h.id, from: "filing", set: { state: "held", attempts: Math.max(0, h.attempts - 1), updated_at: at } }]);
      continue;
    }
    const v = heldVerdict(h);
    if (!v) continue;
    if ("drop" in v) { if (await drop(db, h, v.drop, at)) s.dropped++; continue; }
    if ((await loadQuiet(db, [`${h.repo}#${h.number}`])).size > 0) { if (await drop(db, h, "the pull request is quiet until its fix is published", at)) s.dropped++; continue; }
    const may = await stillActs(db, h.by, [h.issue_repo], { permission: deps.permission });
    if (!may.ok && may.standing === "no") { if (await drop(db, h, `${h.by} no longer has write access to ${h.issue_repo}`, at)) s.dropped++; continue; }
    if (!may.ok) { await markHeld(db, [{ id: h.id, from: "held", set: { reason: `GitHub has not answered on ${h.by}'s access to ${h.issue_repo}` } }]); continue; }
    const g = await guardRepo(db, h.issue_repo, "comment", { operator: h.by }, h.by);
    if ("refused" in g) {
      await markHeld(db, [{ id: h.id, from: "held", set: { reason: g.refused } }]);
      continue;
    }
    if ((o.writes !== undefined && s.writes >= o.writes) || !await actRoomNow(db, now().getTime())) break;
    const attempts = h.attempts + 1;
    if (!(await markHeld(db, [{ id: h.id, from: "held", set: { state: "filing", attempts, updated_at: at } }])).has(h.id)) continue;
    s.writes++;
    const w: Writer = { db, login: h.by };
    let made: { number: number; url: string };
    try {
      made = await createIssue(w, g, deps.exec ?? defaultExec, { repo: h.issue_repo, target: ref(h.repo, h.number), title: h.title, body: h.body, action: "act-open-issue" }, NOTE, { source: "conversation", card: h.card_id, held: h.id });
    } catch (e) {
      const reason = oneLine(e);
      // The network or GitHub is likely failing: the rest waits for the next run.
      if (!(e instanceof IssueError) || !e.clear) { s.unknown++; break; }
      // The write pacing, a rate limit of GitHub's or a failure before the request: nothing was made and no try is counted. The job fails; the failure backoff ignores the pacing's message, so the next pass runs it again.
      if (e.later) {
        await markHeld(db, [{ id: h.id, from: "filing", set: { state: "held", attempts: h.attempts } }]);
        s.paced = reason;
        break;
      }
      const end = attempts >= HELD_MAX_ATTEMPTS;
      await move(db, [{ h, from: "filing", set: { state: end ? "failed" : "held", reason, updated_at: now().toISOString() }, ...(end && { say: `The issue "${h.title}" held for after the merge could not be opened: ${reason}.` }) }]);
      s.failed.push({ ref: ref(h.repo, h.number), reason });
      continue;
    }
    await move(db, [{ h, from: "filing", set: { state: "filed", issue_number: made.number, url: made.url, reason: null, updated_at: now().toISOString() }, say: `The PR merged: opened ${ref(h.issue_repo, made.number)}, the issue "${h.title}" held for after the merge.` }]);
    s.filed++;
  }
  return s;
}

const actRoomNow = async (db: Db, ms: number): Promise<boolean> => roomFor(await loadActRoom(db, new Date(ms)), 1);
