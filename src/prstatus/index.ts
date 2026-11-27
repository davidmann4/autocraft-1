// The PR status comment: one comment per PR the pipeline works on, posted at the first step past triage (review, fix-up,
// CI, a decision, the merge queue) and edited in place whenever its status line changes; GitHub sends no notification for
// an edit. The line comes from the public status layer (src/public/status.ts), so it never carries hold reasons or review
// text; a security fix gets the same line as any PR. Places in the queue past QUEUE_EXACT show as one bucket, so a merge
// or a new batch edits only the PRs near the front. Writes go through src/github/write.ts as bulk writes (half the pacing
// budget), under the repo's PR status switch (src/prstatus/approval.ts) and the step's daily limit. The comment of an item a person
// started or approved needs no switch: their start is its approval (src/core/gates.ts showsWorkFor), under the app identity. No timer: the planner
// queues the step when a PR's line differs from the one posted; a PR whose writes keep failing waits out a backoff.
//
// Every item a person started, issue or PR, gets the comment as soon as it starts, built from the workflow's lines (src/workflow/status.ts): where it stands, who started,
// approved, answered or held it, its steps, its place in the merge queue, its numbered parts, the open recommendation and who it asks
// (plain logins, no mention: an edit notifies nobody anyway). A row only the automatic merge rule started asks nobody: its state line
// says why it stopped and what AutoCraft would do. A quiet PR's comment carries no parts, recommendation or blocker reason. Items nobody started keep the line above; one that was held
// before anyone started it has no steps, and its comment says so once nobody holds it any more.
import { commentStatuses, type PublicStatus, type PublicStep } from "../public/status.ts";
import { guardRepo } from "../core/guard.ts";
import type { By } from "../core/gates.ts";
import { ghComment, ghEditComment, WritePacedError, type Writer } from "../github/write.ts";
import { mentionName, shownMention } from "../github/slugs.ts";
import { appSlug, githubIdentity, ownLoginTest, plainLogin } from "../github/identity.ts";
import { leaseItem } from "../runner/leases.ts";
import { exec as realExec, type Exec } from "../fixup/git.ts";
import { Client, type Querier } from "../mirror.ts";
import { ownerOf } from "../owners.ts";
import { envVar } from "../env.ts";
import { itemPath, shortRepo } from "../../web/src/lib/links.ts";
import { jobItem } from "../runner/job-items.ts";
import type { Db } from "../db/index.ts";
import { t } from "../i18n/index.ts";
import { freshConfig } from "../data/control/index.ts";
import { countStatusRetriesDue, loadStatusRetriesAt, saveStatusComments, workflowActors, type StatusRow } from "../data/workflow/index.ts";
import { loadStatusExtras, loadStatusInputs } from "../data/views/prStatus.ts";
import { attributionLines, currentStep, listText, queueLine, recommendationLine, stateLine, stepLines, workflowSteps, type Progress } from "../workflow/status.ts";
import { openQuestion } from "../workflow/asked.ts";
import { heldWork, type ItemWorkflow, type PlanPart } from "../workflow/types.ts";
import { legWaits } from "../workflow/waits.ts";

export const ACTOR = "pr-status";
/** Ends every status comment, so the comment is found again on GitHub when the stored row is missing. */
export const MARKER = "<!-- autocraft:pr-status -->";
/** Places up to this one are shown exactly; later ones as "N or more PRs ahead". */
export const QUEUE_EXACT = 10;
const HISTORY_MAX = 8;

/** The comment's words for each public step. */
const WORDS: Record<PublicStep, string> = {
  New: "Waiting for review", Triaged: "Waiting for review", "In review": "In review", "Waiting for CI": "Waiting for CI",
  "Fix-up in progress": "Fix-up in progress", "Needs a maintainer decision": "Waiting for a maintainer decision",
  "In the merge queue": "In the merge queue", Merged: "Merged", Closed: "Closed",
};
/** Steps that do not start a comment: the PR is not past triage yet, or already ended. */
const NO_FIRST_POST = new Set<PublicStep>(["New", "Triaged", "Merged", "Closed"]);

/** An item a person started in a repo on the maintainer workflow: its latest workflow, the latest answer, and whether it is a quiet PR. */
export type WorkflowFacts = { wf: ItemWorkflow; answered: { by: string; at: string } | null; quiet: boolean; /** waits.ts legWaits. */ wait?: string | null };
export type StatusFacts = {
  status: PublicStatus;
  /** The PR number of the PR's open merge batch, or of the batch it merged with. */ batch?: { pr: number };
  workflow?: WorkflowFacts;
};

/** The status line: the step, with the place in the merge queue or the merge batch. */
export function statusLine(f: StatusFacts): string {
  const s = f.status, word = WORDS[s.step];
  if (s.step === "Merged") return f.batch ? `${word} with merge batch #${f.batch.pr}` : word;
  if (s.step !== "In the merge queue") return word;
  if (f.batch) return `${word}: checked in merge batch #${f.batch.pr}`;
  if (!s.queue) return word;
  if (s.queue.position === 1) return `${word}, next in line`;
  return s.queue.position <= QUEUE_EXACT ? `${word}, #${s.queue.position} in line` : `${word}, ${QUEUE_EXACT} or more PRs ahead`;
}

/** Where the machinery is, from the public step, for the workflow's steps. */
function progressOf(f: StatusFacts, wf: ItemWorkflow): Progress {
  switch (f.status.step) {
    case "Merged": return "merged";
    case "In the merge queue": return f.batch ? "batched" : "queued";
    case "Waiting for CI": return "waiting-ci";
    case "Fix-up in progress": return "fixing";
    case "Needs a maintainer decision":
    case "Closed": return "other";
    default: return f.status.kind === "issue" && wf.entry === "implement" ? "implementing" : "reviewing";
  }
}

/** One numbered part as the status comment lists it: `- **2** title (dropped)`. */
export const partLine = (p: Pick<PlanPart, "n" | "title" | "state">): string => `- ${p.state === "dropped" ? t("**{n}** {title} (dropped)", { n: p.n, title: p.title })
  : p.state === "fixed" ? t("**{n}** {title} (fixed)", { n: p.n, title: p.title }) : t("**{n}** {title}", { n: p.n, title: p.title })}`;

/** The first line of a started item's status comment: where it stands. `wait: false` leaves out what a running item waits for (waits.ts legWait), not the follow-ups a merge filed. */
export function workflowHead(f: StatusFacts & { workflow: WorkflowFacts }, o: { wait?: boolean } = {}): string {
  const { wf, quiet, wait } = f.workflow, s = f.status;
  if (s.step === "Merged") return f.batch ? t("Merged with merge batch #{pr}", { pr: f.batch.pr }) : t("Merged");
  if (s.step === "Closed") return t("Closed");
  if (quiet && (wf.state === "recommending" || wf.state === "blocked")) return t("Waiting for a maintainer decision");
  return stateLine(wf, currentStep(workflowSteps(wf, progressOf(f, wf))), undefined, o.wait === false && wf.state !== "done" ? null : wait ?? null);
}

/**
 * The paragraphs of the status comment of a started item, before the links. A quiet PR's carry no parts, no recommendation and
 * no blocker reason: an item waiting for an answer there only says it waits for a maintainer.
 */
export function workflowLines(f: StatusFacts & { workflow: WorkflowFacts }): string[] {
  const { wf, answered, quiet } = f.workflow, s = f.status;
  const steps = workflowSteps(wf, progressOf(f, wf));
  const ended = s.step === "Merged" || s.step === "Closed";
  const out = [`**${workflowHead(f)}**`, attributionLines(wf, answered).join("\n"), ...(wf.state === "stopped" && heldWork(wf).unstarted ? [] : [stepLines(steps).join("\n")])];
  if (s.step === "In the merge queue") {
    if (f.batch) out.push(t("Checked in merge batch #{pr}", { pr: f.batch.pr }));
    else if (s.queue) out.push(s.queue.position <= QUEUE_EXACT ? queueLine(s.queue.position) : t("{n} or more items ahead", { n: QUEUE_EXACT }));
  }
  if (!quiet && wf.plan.length) out.push([t("Parts:"), ...wf.plan.map(partLine)].join("\n"));
  const open = ended ? null : openQuestion(wf);
  if (open && !quiet) out.push(recommendationLine(open.rec)!);
  if (open && !quiet) out.push(t("Asks {logins}", { logins: listText(open.to) }));
  return out;
}

/** The comment body of a started item: its paragraphs, how to answer when a recommendation is open, and the links. */
export function workflowBody(repo: string, number: number, paragraphs: string[], answerable: boolean, slug: string | null, base: string | null): string {
  const parts = [...paragraphs];
  if (answerable && slug) parts.push(t("Answer in a comment that starts with `@{slug}`.", { slug }));
  if (base) parts.push(t("Details for maintainers: {link}", { link: `[${t("this item")}](${base}${itemPath(repo, number)})` }));
  return `${parts.join("\n\n")}\n\n${MARKER}`;
}

export type HistoryStep = { step: string; at: string };

/** The history with `step` added when it differs from the last one, keeping the newest HISTORY_MAX. */
export function withStep(history: HistoryStep[], step: string, at: string): HistoryStep[] {
  const out = history.at(-1)?.step === step ? history : [...history, { step, at }];
  return out.slice(-HISTORY_MAX);
}

const when = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** The comment body (write.ts adds the note line). `base`: the dashboard's address, null when none is configured. */
export function commentBody(repo: string, number: number, line: string, history: HistoryStep[], inQueue: boolean, base: string | null): string {
  const parts = [`**Status:** ${line}`];
  if (history.length > 1) parts.push(`**History:** ${history.map((h) => `${h.step} (${when(h.at)})`).join(" → ")}`);
  if (base) {
    const links = [`[this PR](${base}${itemPath(repo, number)})`];
    if (inQueue) links.push(`[merge queue](${base}/next?repo=${encodeURIComponent(shortRepo(repo))})`);
    parts.push(`Details for maintainers: ${links.join(" · ")}`);
  }
  return `${parts.join("\n\n")}\n\n${MARKER}`;
}


type Stored = StatusRow;
/** `released`: the comment of a held item that nobody had started, and that nobody holds any more. `commandedBy`: the person who started or approved the item's workflow, whose start is the comment's approval (under the app identity). */
export type Due = { number: number; facts: StatusFacts; line: string; prev: Stored | null; released?: true; commandedBy?: string };

/** A started or held item's line: its whole comment text, in paragraphs. */
const isWorkflowText = (line: string | null | undefined): boolean => !!line?.includes("\n\n");

/** How long a status comment keeps a line that differs from the current one only by Running against waiting for a Task Runner. */
export const WAIT_FLIP_MS = 60 * 60_000;

/**
 * Whether two comment texts differ only in their head line flipping between "Running: <step>" and "Waiting for a Task Runner": a
 * step that waits for a Task Runner is claimable for a moment each time the runner reports, which flips the line without any change
 * an editor of the comment needs to see. A head line that names a person's Task Runner, which comments already on GitHub may carry,
 * is never such a flip, so the next edit takes the name out.
 */
export function onlyWaitFlip(prev: string, line: string): boolean {
  const split = (s: string): [string, string] => { const i = s.indexOf("\n\n"); return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i)]; };
  const [a, rest] = split(prev), [b, rest2] = split(line);
  const running = (h: string) => h.startsWith("**Running: ");
  const waiting = (h: string) => h === `**${t("Waiting for a Task Runner")}**`;
  return rest === rest2 && a !== b && ((running(a) && waiting(b)) || (waiting(a) && running(b)));
}

const parseSteps = (s: string): HistoryStep[] => {
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is HistoryStep => !!x && typeof x.step === "string" && typeof x.at === "string") : [];
  } catch {
    return [];
  }
};

/** Failures in a row before a PR waits; the wait starts at RETRY_FIRST_MS and doubles up to RETRY_MAX_MS. */
export const RETRY_AFTER = 3;
const RETRY_FIRST_MS = 3_600_000, RETRY_MAX_MS = 24 * 3_600_000;
/** Every failure registers a wait end; the first RETRY_AFTER failures wait the first step, then it doubles. */
const retryAt = (failures: number, now: number): string =>
  new Date(now + Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.max(0, failures - RETRY_AFTER))).toISOString();

/**
 * The PRs of each of `repos` whose comment is due: an open PR in the pipeline's scope past triage with no comment yet, or a PR
 * whose posted line differs from its line now. Out of scope (the repo's Pipeline off, a person ended the item) a posted
 * comment still gets its Merged or Closed edit, and that of an item whose hold left nothing to go on with says it is not held any more. Batch PRs get none; a PR waiting out a failure backoff is left out; a member
 * of a batch whose PR has not opened yet keeps its line. `approved`: the repos with the PR status switch on (all of `repos` when absent);
 * in the others only the items a person started or approved get their comment, under the app identity.
 */
export async function statusDueIn(db: Db, repos: readonly string[], now: number = Date.now(), approved?: ReadonlySet<string>): Promise<Map<string, Due[]>> {
  const switched = approved ? repos.filter((r) => approved.has(r)) : repos;
  const [inputs, app] = await db.together(() => Promise.all([loadStatusInputs(db, repos, switched), switched.length < repos.length ? githubIdentity(db).then((i) => i === "app") : false]));
  const refs: { repo: string; number: number }[] = [];
  const prevOf = new Map<string, Stored>();
  const commander = (w: { wf: ItemWorkflow } | undefined): string | null => (w && app ? workflowActors(w.wf, null)[0] ?? null : null);
  for (const [repo, { stored, inScope, started }] of inputs) {
    const on = !approved || approved.has(repo);
    for (const r of stored) prevOf.set(`${repo}#${r.number}`, r);
    for (const n of new Set([...inScope, ...[...started].filter(([, w]) => w.open).map(([n]) => n), ...stored.map((r) => r.number)])) {
      if (!on && commander(started.get(n)) === null) continue;
      const at = prevOf.get(`${repo}#${n}`)?.retry_at;
      if (!at || Date.parse(at) <= now) refs.push({ repo, number: n });
    }
  }
  const out = new Map<string, Due[]>();
  if (!refs.length) return out;
  const wfs = refs.flatMap(({ repo, number }) => { const w = inputs.get(repo)!.started.get(number); return w ? [w.wf] : []; });
  const [statuses, { batches, answered, quiet }, waits] = await db.together(() => Promise.all([
    // The comment is public: it names no person's Task Runner (waits.ts WaitReader).
    commentStatuses(db, refs), loadStatusExtras(db, refs, wfs.map((w) => w.id)), legWaits(db, wfs, Date.now(), { shown: false }),
  ]));
  for (const { repo, number: n } of refs.sort((a, b) => a.number - b.number)) {
    const key = `${repo}#${n}`, { inScope, started } = inputs.get(repo)!;
    const status = statuses.get(key), prev = prevOf.get(key) ?? null;
    if (!status) continue;
    const ended = status.step === "Merged" || status.step === "Closed";
    const w = started.get(n);
    if (!inScope.has(n) && !w?.open && !ended) {
      if (w === undefined && prev && isWorkflowText(prev.line)) (out.get(repo) ?? out.set(repo, []).get(repo)!).push({ number: n, facts: { status }, line: t("Not held any more. AutoCraft has no work on it."), prev, released: true });
      continue;
    }
    const open = status.queue ? batches.get(`open:${key}`) : undefined;
    if (open && open.pr === null) continue;
    const merged = status.step === "Merged" ? batches.get(`merged:${key}`) : undefined;
    const pr = (open ?? merged)?.pr;
    const a = w ? answered.get(w.wf.id) : undefined;
    const workflow: WorkflowFacts | undefined = w ? { wf: w.wf, answered: a ? { by: a.login, at: a.at } : null, quiet: quiet.has(key), wait: waits.get(w.wf.id) ?? null } : undefined;
    const facts: StatusFacts = { status, ...(pr ? { batch: { pr } } : {}), ...(workflow ? { workflow } : {}) };
    // A started item's line is its whole comment text, so any change edits it; once it ended, the final line is the same as any PR's.
    const line = facts.workflow && !ended ? workflowLines({ ...facts, workflow: facts.workflow }).join("\n\n") : statusLine(facts);
    const first = facts.workflow ? !ended : !NO_FIRST_POST.has(status.step);
    const by = commander(w);
    if (prev?.line != null && prev.line !== line && onlyWaitFlip(prev.line, line) && Date.parse(prev.updated_at) > now - WAIT_FLIP_MS) continue;
    if (prev?.line != null ? prev.line !== line : first) (out.get(repo) ?? out.set(repo, []).get(repo)!).push({ number: n, facts, line, prev, ...(by ? { commandedBy: by } : {}) });
  }
  return out;
}

export const statusDue = async (db: Db, repo: string, now: number = Date.now(), approved?: ReadonlySet<string>): Promise<Due[]> => (await statusDueIn(db, [repo], now, approved)).get(repo) ?? [];

/** The earliest end of a failure backoff of each repo's comments after `now`. */
export async function statusRetriesAt(db: Db, repos: readonly string[], now: number = Date.now()): Promise<Map<string, number>> {
  return await loadStatusRetriesAt(db, repos, now);
}

/** Backoffs that have ended, for the lane's fingerprint: the planner tries those PRs again once the time has passed. */
export async function statusRetriesDue(db: Db, now: number = Date.now()): Promise<string> {
  return String(await countStatusRetriesDue(db, now));
}

const FIND_QUERY = `query($owner: String!, $name: String!, $n: Int!, $before: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $n) {
    comments(last: 100, before: $before) { pageInfo { hasPreviousPage startCursor } nodes { databaseId body author { login } } }
  } }
}`;
const ISSUE_FIND_QUERY = FIND_QUERY.replace("pullRequest(number: $n)", "issue(number: $n)");
const MAX_PAGES = 50;
type GhComment = { databaseId: number; body: string; author: { login: string } | null };
type Found = { id: string; author: string | null };

/**
 * Pages back through the PR's comments from the newest until `pick` matches one. null: the PR was read and has no such
 * comment. Throws when the PR cannot be read or has more comments than MAX_PAGES pages.
 */
async function searchComments(q: Querier, repo: string, number: number, pick: (c: GhComment) => boolean, issue = false): Promise<Found | null> {
  let before: string | null = null;
  type Comments = { comments?: { pageInfo?: { hasPreviousPage: boolean; startCursor: string | null }; nodes?: GhComment[] } } | null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await q.query(issue ? ISSUE_FIND_QUERY : FIND_QUERY, { owner: ownerOf(repo), name: repo, n: number, before }) as { repository?: { pullRequest?: Comments; issue?: Comments } };
    const c = (issue ? r.repository?.issue : r.repository?.pullRequest)?.comments;
    if (!c) throw new Error(issue ? "the issue could not be read" : "the pull request could not be read");
    const hit = (c.nodes ?? []).findLast(pick);
    if (hit) return { id: String(hit.databaseId), author: hit.author ? plainLogin(hit.author.login) : null };
    if (!c.pageInfo?.hasPreviousPage || !c.pageInfo.startCursor) return null;
    before = c.pageInfo.startCursor;
  }
  throw new Error(`more than ${MAX_PAGES * 100} comments: not searched to the end`);
}

/** The login our comments are written as now (plainLogin), or null when it is not known. */
async function writerLogin(db: Db): Promise<string | null> {
  const login = await githubIdentity(db) === "box" ? (await freshConfig(db, ["pipeline_login"])).pipelineLogin : appSlug();
  return login ? plainLogin(login) : null;
}

const commentIdOf = (stdout: string): string | null => /#issuecomment-(\d+)/.exec(stdout)?.[1] ?? null;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);
const notFound = (r: { stderr: string; stdout: string }): boolean => /404|not found/i.test(`${r.stderr} ${r.stdout}`);

export type PrStatusParams = { repo: string; by: By; runId: string; limit: number; log?: (line: string) => void; querier?: Querier; exec?: Exec; now?: () => Date; base?: string | null; /** Replaces the installation-token minter (tests). */ mint?: Writer["mint"] };
export type PrStatusResult = { posted: string[]; edited: string[]; gone: string[]; failed: string[]; due: number; paced: boolean };

/**
 * Posts or edits the due status comments of one repo, at most `limit`, under a per-repo lease so two jobs never post on
 * the same PR. One PR failing does not stop the others; a paced write ends the job.
 */
export async function runPrStatus(db: Db, p: PrStatusParams): Promise<PrStatusResult> {
  const log = p.log ?? (() => {});
  const out: PrStatusResult = { posted: [], edited: [], gone: [], failed: [], due: 0, paced: false };
  const now = p.now ?? (() => new Date());
  // Without the repo's switch only the comments of items a person started or approved are due: their starts are the approval (members).
  const repoGrant = await guardRepo(db, p.repo, "status", p.by);
  const only = "refused" in repoGrant ? new Set<string>() : undefined;
  const dueNow = async (): Promise<Due[]> => await statusDue(db, p.repo, now().getTime(), only);
  const first = await dueNow();
  if (!first.length) { if ("refused" in repoGrant) log(repoGrant.refused); return out; }
  const grant = async (due: readonly Due[]) => ("refused" in repoGrant ? await guardRepo(db, p.repo, "status", p.by, undefined, { members: due.map((d) => ({ ok: d.commandedBy !== undefined })) }) : repoGrant);
  const g0 = await grant(first);
  if ("refused" in g0) { log(g0.refused); return out; }
  const release = await leaseItem(db, `pr-status:${p.repo}`, log);
  if (!release) return out;
  try {
    const due = await dueNow();
    out.due = due.length;
    const g = due.length ? await grant(due) : g0;
    if ("refused" in g) { log(g.refused); return out; }
    const w: Writer = { db, login: ACTOR, ...(p.mint ? { mint: p.mint } : {}) };
    const q = p.querier ?? new Client(500), run = p.exec ?? realExec;
    const base = (p.base === undefined ? envVar("BASE_URL") ?? null : p.base)?.replace(/\/+$/, "") || null;
    const me = await writerLogin(db), ours = await ownLoginTest(db, p.repo), slug = shownMention(appSlug(), await mentionName(db));
    for (const d of due.slice(0, Math.max(0, p.limit))) {
      const ref = `${p.repo}#${d.number}`, at = now().toISOString();
      const issue = d.facts.status.kind === "issue";
      const history = withStep(d.prev ? parseSteps(d.prev.steps) : [], WORDS[d.facts.status.step], at);
      const wf = d.facts.workflow;
      const ended = d.facts.status.step === "Merged" || d.facts.status.step === "Closed";
      const body = wf
        ? workflowBody(p.repo, d.number, workflowLines({ ...d.facts, workflow: wf }), !ended && !wf.quiet && openQuestion(wf.wf) !== null, slug, base)
        : d.released ? workflowBody(p.repo, d.number, [`**${d.line}**`], false, slug, base)
        : commentBody(p.repo, d.number, d.line, history, d.facts.status.step === "In the merge queue", base);
      const shown = d.line.split("\n")[0];
      const row = { line: d.line, steps: JSON.stringify(history), final: d.facts.status.step === "Merged" ? 1 : 0, failures: 0, retry_at: null, updated_at: at };
      try {
        let found: Found | null = d.prev?.comment_id ? { id: d.prev.comment_id, author: d.prev.author } : await searchComments(q, p.repo, d.number, (c) => c.body.includes(MARKER) && ours(c.author?.login ?? null), issue);
        // A comment written as another identity (the box account before a switch to the app) cannot be edited: a new one replaces it.
        if (found && me && found.author && found.author !== me) found = null;
        const r = found
          ? await ghEditComment(w, g, run, "pr-status-comment-edit", { repo: p.repo, number: d.number, commentId: found.id }, { by: "fixed" }, body, { run: p.runId, line: shown })
          : await ghComment(w, g, run, "pr-status-comment", { repo: p.repo, number: d.number, pr: !issue }, { by: "fixed" }, body, { run: p.runId, line: shown });
        if (r.code !== 0 && found && notFound(r)) {
          // Deleted on GitHub (the PR reads and the comment is not on it): never posted again on this PR.
          const id = found.id;
          if (await searchComments(q, p.repo, d.number, (c) => String(c.databaseId) === id, issue) === null) {
            await store(db, p.repo, d.number, { ...row, comment_id: id, author: found.author, line: d.prev?.line ?? null, steps: d.prev?.steps ?? "[]", final: 1 });
            out.gone.push(ref);
            await jobItem(db, p.repo, d.number, "status comment deleted on GitHub; not posted again", log);
            continue;
          }
        }
        if (r.code !== 0) throw new Error(oneLine(r.stderr || r.stdout) || `exit code ${r.code}`);
        await store(db, p.repo, d.number, { ...row, comment_id: found?.id ?? commentIdOf(r.stdout), author: found ? found.author : me });
        (found ? out.edited : out.posted).push(ref);
        await jobItem(db, p.repo, d.number, `status comment ${found ? "edited" : "posted"}: ${shown}`, log);
      } catch (e) {
        if (e instanceof WritePacedError) { out.paced = true; log(`${p.repo}: ${e.message}`); break; }
        out.failed.push(ref);
        const failures = (d.prev?.failures ?? 0) + 1;
        await store(db, p.repo, d.number, { comment_id: d.prev?.comment_id ?? null, author: d.prev?.author ?? null, line: d.prev?.line ?? null, steps: d.prev?.steps ?? "[]", final: 0, failures, retry_at: retryAt(failures, now().getTime()), updated_at: at });
        await jobItem(db, p.repo, d.number, `status comment failed: ${oneLine(String((e as Error).message ?? e))}`, log);
      }
    }
  } finally {
    await release();
  }
  return out;
}

type RowValues = Omit<StatusRow, "repo" | "number">;
async function store(db: Db, repo: string, number: number, row: RowValues): Promise<void> {
  await saveStatusComments(db, [{ repo, number, ...row }]);
}
