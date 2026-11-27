// Runs one conversation card once, as the person who pressed it: a command goes through the workflow's runCommand (the same core as
// GitHub, Discord, the agent and the command box); a comment, a label and the GitHub actions without a command (reopen, transfer,
// assign, request reviewers, open an issue) through src/github/write.ts with the presser's login on the audit row. Cards never run
// on their own.
import { createHash } from "node:crypto";
import { guardRepo } from "../core/guard.ts";
import { readLive } from "../act/live.ts";
import { stillActs } from "../act/still.ts";
import type { RefreshDeps } from "../preapproval/permissions.ts";
import { loadAccess } from "../data/access/index.ts";
import { actBlocked } from "../core/repo-approvals.ts";
import { addAudit } from "../data/control/index.ts";
import { addHeld, failCards, loadActRoom, loadCards, loadQueue, markCard, sweepRunningCards as sweepCards, type CardRow } from "../data/conversations/index.ts";
import { applyLocal, loadItems, type ItemOf } from "../data/mirror/index.ts";
import { addStageEvents } from "../data/planner/index.ts";
import { loadQuiet } from "../data/security/index.ts";
import { listWorkflows } from "../data/workflow/index.ts";
import { cardWriteCount, needOf, queuedAhead, roomFor, type QueueArgs } from "./queue.ts";
import { addLabels, assignTo, commentOn, createIssue, IssueError, removeLabel, reopenItem, requestReviewers, transferIssue, type Note, type Writer } from "../github/write.ts";
import { exec as defaultExec, type Exec } from "../fixup/git.ts";
import { repoLabels } from "../labels/github.ts";
import { Client, type Querier } from "../mirror.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { actionRefusal, cardRepos, dependsOnCode, isRegistry, itemLabels, otherTypeLabel, readParams, type CardParams, type FollowUp, type OtherAction, type RegistryCommand } from "./cards.ts";
import { ConversationError, insertTurn, prChanged, seenHead, systemBlock, type StoreDeps } from "./store.ts";
import { NOTE_MAX } from "./types.ts";
import { ownerOf } from "../owners.ts";
import { parse } from "../workflow/parse.ts";
import { runCommand } from "../workflow/apply.ts";
import type { Surface } from "../workflow/types.ts";
import type { Db } from "../db/index.ts";

export type { CardRow };

/** A card that has run longer than this is taken as crashed. */
export const RUNNING_STALE_MS = 10 * 60_000;

/** `canWrite` is the presser's live write access to a repo; the shell has none to check. */
export type ActDeps = StoreDeps & {
  querier?: Querier;
  /** Stands in for the GitHub App's read of the presser's write permission. */
  permission?: RefreshDeps["permission"];
  /** Runs `gh` for an issue the card opens and for what a command starts. */
  exec?: Exec;
  canWrite?: (repo: string) => Promise<boolean>;
  /** Where the press came from (default: the dashboard). */
  via?: Surface;
  /** The note with the press. */
  note?: string;
  /** The presser's role, named in the conversation block (default operator). */
  role?: string;
  /** The presser is not an operator: the note is stored and shown but never put in the model's block. */
  noteStaysOut?: boolean;
  /** Set by the Act step's drain: run the queued card as its presser pressed it. */
  drain?: boolean;
};

export const cardOf = async (db: Db, id: number): Promise<CardRow | undefined> => (await loadCards(db, [id])).get(id);

async function need(db: Db, id: number): Promise<CardRow> {
  const c = await cardOf(db, id);
  if (!c) throw new ConversationError(404, `no card ${id}`);
  return c;
}

const RETIRED = "this card was made for a question that no longer exists; ask Opus again";

function paramsOf(c: CardRow): CardParams {
  const p = readParams(c.kind, c.params);
  if (!p) throw new ConversationError(409, RETIRED);
  return p;
}

/** Cards come from the conversation prompt, which always runs on its first listed model. */
const CARD_NOTE: Note = { by: "operator", model: CLAUDE_PROMPTS["conversation.turn"].models[0] };

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 300);
const ref = (repo: string, n: number) => `${repo}#${n}`;
const nowOf = (d?: StoreDeps): Date => d?.now?.() ?? new Date();

/** What a press is bound to: the card's text and parameters as the presser's screen showed them. Any edit gives a new digest. */
export const cardDigest = (c: Pick<CardRow, "text" | "params">): string => createHash("sha256").update(JSON.stringify([c.text, c.params])).digest("hex").slice(0, 16);

type Outcome = { result: string; url: string | null; held?: FollowUp[]; workflowId?: number | null };
type Item = ItemOf<"text">;

async function liveOpen(q: Querier, repo: string, n: number) {
  const live = await readLive(q, repo, n);
  if (!live) throw new Error("GitHub returned no such item");
  if (live.state !== "OPEN") throw new Error(`already ${live.state.toLowerCase()} on GitHub`);
  return live;
}

type Ctx = { db: Db; c: CardRow; by: string; q: Querier; exec: Exec; at: string; w: Writer; item: Item | undefined; source: { source: string; card: number } };

async function postComment({ db, c, by, q, w, source }: Ctx): Promise<Outcome> {
  const g = await actGrant(db, c.repo, by);
  const live = await liveOpen(q, c.repo, c.number);
  const url = await commentOn(w, g, q, "act-comment", { repo: c.repo, number: c.number, id: live.id }, CARD_NOTE, c.text ?? "", source);
  return { result: "Comment posted", url: url || null };
}

async function setLabel({ db, c, by, q, at, w, item, source }: Ctx, label: string, remove: boolean): Promise<Outcome> {
  const g = await actGrant(db, c.repo, by, "labels");
  const have = item ? itemLabels(item) : [];
  const other = remove ? null : otherTypeLabel(have, label);
  if (other) throw new Error(`the item already has the type label "${other}" and an item has one type label`);
  const live = await liveOpen(q, c.repo, c.number);
  const id = (await repoLabels(q, c.repo)).labels.get(label.toLowerCase());
  if (!id) throw new Error(`the label "${label}" does not exist on ${c.repo}`);
  if (remove) {
    await removeLabel(w, g, q, { repo: c.repo, number: c.number, id: live.id }, { id, name: label }, source);
    // The mirror catches up at the next sync; a label card pressed after this one reads it now.
    if (item) await applyLocal(db, [{ kind: "labels", repo: c.repo, number: c.number, labels: have.filter((x) => x.toLowerCase() !== label.toLowerCase()) }]);
    return { result: `Label "${label}" removed`, url: null };
  }
  const done = await addLabels(w, q, c.repo, [{ number: c.number, id: live.id, labelIds: [id], names: [label], g }], undefined, source);
  if (!done.includes(c.number)) throw new Error("GitHub did not add the label");
  await addStageEvents(db, [{ repo: c.repo, number: c.number, stage: "labeled", at, actor: by, note: `added: ${label}` }]);
  return { result: `Label "${label}" added`, url: null };
}

const USER_ID = `query($login: String!) { user(login: $login) { id login } }`;
const REPO_ID = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }`;

async function userOf(q: Querier, login: string): Promise<{ id: string; login: string }> {
  const d = await q.query(USER_ID, { login }) as { user?: { id: string; login: string } | null };
  if (!d.user) throw new Error(`GitHub has no user ${login}`);
  return d.user;
}

/** Fails unless GitHub says now that the login can write to the repo. */
async function needLiveWrite(q: Querier, repo: string, login: string): Promise<void> {
  const p = await liveWrite(q, repo, login);
  if (p === "no") throw new Error(`${login} does not have write access to ${repo}`);
  if (p === "transient") throw new Error(`could not read ${login}'s access to ${repo} from GitHub`);
}

const sameLogin = (a: string | null | undefined, b: string): boolean => a?.toLowerCase() === b.toLowerCase();

/** A GitHub action with no registered command. */
async function action(ctx: Ctx, a: OtherAction): Promise<Outcome> {
  const { db, c, by, q, w, item, source } = ctx;
  const target = { repo: c.repo, number: c.number };
  switch (a.word) {
    case "reopen": {
      const g = await actGrant(db, c.repo, by);
      const live = await readLive(q, c.repo, c.number);
      if (!live) throw new Error("GitHub returned no such item");
      if (live.state === "OPEN") throw new Error("already open on GitHub");
      if (live.state !== "CLOSED") throw new Error(`${live.state.toLowerCase()} on GitHub: it cannot be reopened`);
      await reopenItem(w, g, q, { ...target, id: live.id, pr: live.type === "PullRequest" }, source);
      return { result: "Reopened", url: null };
    }
    case "open_issue": {
      const g = await actGrant(db, a.repo, by);
      try {
        const made = await createIssue(w, g, ctx.exec, { repo: a.repo, target: ref(c.repo, c.number), title: a.title, body: a.body, action: "act-open-issue" }, CARD_NOTE, source);
        return { result: `Opened ${ref(a.repo, made.number)}`, url: made.url };
      } catch (e) {
        if (e instanceof IssueError && !e.clear) throw new Error(`${e.message}; the issue may exist in ${a.repo}, check before running again`);
        throw e;
      }
    }
    case "transfer": {
      const g = await actGrant(db, c.repo, by);
      const gTo = await actGrant(db, a.to, by);
      const live = await liveOpen(q, c.repo, c.number);
      if (live.type !== "Issue") throw new Error("only an issue can be moved to another repository");
      if (ownerOf(a.to).toLowerCase() !== ownerOf(c.repo).toLowerCase()) throw new Error("an issue moves only between repositories of one owner");
      const to = await q.query(REPO_ID, { owner: ownerOf(a.to), name: a.to }) as { repository?: { id: string } | null };
      if (!to.repository) throw new Error(`GitHub has no repository ${a.to}`);
      const url = await transferIssue(w, g, gTo, q, { ...target, id: live.id }, { repo: a.to, id: to.repository.id }, source);
      return { result: `Moved to ${a.to}`, url: url || null };
    }
    case "assign": {
      const g = await actGrant(db, c.repo, by);
      const live = await liveOpen(q, c.repo, c.number);
      if (!sameLogin(item?.author, a.login)) await needLiveWrite(q, c.repo, a.login);
      await assignTo(w, g, q, { ...target, id: live.id }, await userOf(q, a.login), source);
      return { result: `Assigned ${a.login}`, url: null };
    }
    case "request_reviewers": {
      const g = await actGrant(db, c.repo, by);
      const live = await liveOpen(q, c.repo, c.number);
      if (live.type !== "PullRequest") throw new Error("reviewers can be requested on a PR only");
      const users: { id: string; login: string }[] = [];
      for (const l of a.logins) {
        if (sameLogin(item?.author, l)) throw new Error(`${l} is the PR's author`);
        await needLiveWrite(q, c.repo, l);
        users.push(await userOf(q, l));
      }
      await requestReviewers(w, g, q, { ...target, id: live.id }, users, source);
      return { result: `Asked ${a.logins.join(", ")} for a review`, url: null };
    }
  }
}

/** The Act approval of `repo` for the presser's write. Room under the daily limit was taken before it (doCard). */
async function actGrant(db: Db, repo: string, by: string, need: "comment" | "labels" = "comment") {
  const g = await guardRepo(db, repo, need, { operator: by }, by);
  if ("refused" in g) throw new Error(g.refused);
  return g;
}

/** A command the workflow did not run: nothing happened, so the card stays proposed. */
class NotRun extends Error {}

/** The card's command as the presser's: the same checks, run and reply line as on every other surface. */
async function command(db: Db, c: CardRow, cmd: RegistryCommand, by: string, at: string, deps: ActDeps): Promise<Outcome> {
  const parsed = parse(cmd.text, { repo: c.repo });
  if (parsed.kind !== "commands") throw new NotRun(`"${cmd.text}" is not a command`);
  // A merge is approved at the head the card was written for; a push in between refuses it.
  const head = cmd.pr && cmd.merges ? seenHead(c.seen) : null;
  const r = await runCommand(db, { login: by, canWrite: deps.canWrite ?? (async () => true) }, deps.via ?? "dashboard",
    { parsed, items: [{ repo: c.repo, number: c.number }], at, ...(head !== null && { head }), ...(deps.exec && { exec: deps.exec }) });
  const o = r.items[0];
  if (!o || o.outcome !== "run") throw new NotRun(o?.line ?? r.lines[0] ?? "the command did not run");
  return { result: o.line.replace(/\.$/, ""), url: null, held: cmd.followups ?? [], workflowId: o.workflowId };
}

const COLLABORATORS = `query($owner: String!, $name: String!, $login: String!) { repository(owner: $owner, name: $name) { collaborators(query: $login, first: 10) { edges { permission node { login } } } } }`;

/**
 * The login's write permission on a repo the box acts on, read from GitHub now. "no" only when the list is empty or its edge for the login
 * has a lower permission; a missing repository or collaborators field (a partial or failed read) is "transient".
 */
export async function liveWrite(q: Querier, repo: string, login: string): Promise<"ok" | "no" | "transient"> {
  try {
    const d = await q.query(COLLABORATORS, { owner: ownerOf(repo), name: repo, login }) as { repository?: { collaborators?: { edges?: { permission: string; node: { login: string } }[] } | null } | null };
    const edges = d.repository?.collaborators?.edges;
    if (!edges) return "transient";
    if (edges.length === 0) return "no";
    const e = edges.find((x) => x.node.login.toLowerCase() === login.toLowerCase());
    if (!e) return "transient";
    return ["WRITE", "MAINTAIN", "ADMIN"].includes(e.permission) ? "ok" : "no";
  } catch {
    return "transient";
  }
}

/** A press from the queue is carried out as its presser if they still may: their role and write access are read again now; one GitHub could not answer for waits. */
async function presserStill(db: Db, by: string, repos: string[], deps: ActDeps): Promise<void> {
  const may = await stillActs(db, by, repos, { permission: deps.permission });
  if (!may.ok) throw may.standing === "no" ? new ConversationError(409, `${by} no longer has write access`) : new ConversationError(503, "GitHub could not be reached to check the presser's access");
}

/**
 * Runs the card once. A card that is not `proposed` is returned unchanged, so a second press (or a double click) does nothing. A command
 * the workflow refuses leaves the card proposed and says why; a failure is stored on the card, which does not run again.
 */
export async function doCard(db: Db, id: number, by: string, deps: ActDeps = {}): Promise<{ card: CardRow; ran: boolean }> {
  const c = await need(db, id);
  if (c.state === "replaced") throw new ConversationError(409, "replaced by a later reply");
  const draining = deps.drain === true && c.state === "queued";
  if (c.state !== "proposed" && !draining) return { card: c, ran: false };
  const params = paramsOf(c);
  const key = ref(c.repo, c.number);
  const [items, quiet, live] = await db.together(() => Promise.all([
    loadItems(db, [{ repo: c.repo, number: c.number }], "text"), loadQuiet(db, [key]), listWorkflows(db, { live: true, refs: [{ repo: c.repo, number: c.number }] }),
  ]));
  const item = items.get(key);
  const cmd = params.kind === "command" ? params.command : null;
  if (dependsOnCode(params) && item && prChanged(item, c.seen)) throw new ConversationError(409, "the PR changed since this was proposed");
  // The plan may have moved, or the PR become quiet (a security fix not yet published), after the card was drafted.
  const refused = actionRefusal(params, { quiet: quiet.size > 0, recAt: live.at(-1)?.recAt ?? null });
  if (refused) throw new ConversationError(409, refused);
  const note = deps.note?.trim() || undefined;
  if (note && note.length > NOTE_MAX) throw new ConversationError(400, `the note is longer than ${NOTE_MAX} characters`);
  const now = nowOf(deps), at = now.toISOString();
  const needW = cardWriteCount(params);
  if (draining && needW > 0) await presserStill(db, by, cardRepos(c.repo, params), deps);
  for (const repo of cardRepos(c.repo, params).filter((r) => r !== c.repo)) {
    const g = await guardRepo(db, repo, "comment", { operator: by }, by);
    if ("refused" in g) throw new ConversationError(409, g.refused);
  }
  let claimed: "busy" | "lost" | { queued: boolean };
  try {
    claimed = await db.write(async () => {
      // Room is taken in this transaction. A press queues behind the presses already waiting.
      const [room, queue] = needW > 0 ? await db.together(() => Promise.all([loadActRoom(db, now), loadQueue(db)])) : [null, null];
      const wait = room !== null && (!roomFor(room, needW) || (!draining && queuedAhead(queue!, id)));
      if (wait && draining) return "busy" as const;
      if (!wait) return await markCard(db, id, [draining ? "queued" : "proposed"], { state: "running", acted_by: by, acted_at: at }) ? { queued: false } : "lost" as const;
      // Refusals a press that has to wait would only meet at the drain are given now.
      const g = await guardRepo(db, c.repo, params.kind === "label" ? "labels" : "comment", { operator: by }, by);
      if ("refused" in g) throw new Error(g.refused);
      const block = await actBlocked(db, c.repo);
      if (block) throw new Error(`The daily GitHub write limit leaves no room and ${block}, so this cannot wait in line`);
      const args: QueueArgs = { ...(note && { note }), ...(deps.noteStaysOut && { noteStaysOut: true }), ...(deps.role && { role: deps.role }) };
      if (!await markCard(db, id, ["proposed"], { state: "queued", acted_by: by, acted_at: at, queued_at: at, queue_args: JSON.stringify(args), error: null })) return "lost" as const;
      await addAudit(db, [{ login: by, action: "conversation-card-queue", target: key, details: { card: id, kind: c.kind } }]);
      await insertTurn(db, c.repo, c.number, {
        kind: "system", login: "system", body: `${by} pressed the card: ${c.description}. Queued: daily GitHub write limit.` + (note ? ` Note: ${note}` : ""),
        block: systemBlock(`The ${deps.role ?? "operator"} ${by} chose the proposed action: ${c.description}. It is queued behind the daily limit of GitHub writes and runs in order when room returns.`),
      }, deps);
      return { queued: true };
    });
  } catch (e) {
    throw new ConversationError(409, String((e as Error).message ?? e));
  }
  if (claimed === "busy") return { card: c, ran: false };
  if (claimed === "lost" || claimed.queued) return { card: await need(db, id), ran: false };

  let out: Outcome | null = null, error: string | null = null;
  try {
    const ctx: Ctx = { db, c, by, q: deps.querier ?? new Client(1000), exec: deps.exec ?? defaultExec, at, w: { db, login: by }, item, source: { source: "conversation", card: c.id } };
    out = cmd ? isRegistry(cmd) ? await command(db, c, cmd, by, at, deps) : await action(ctx, cmd) : params.kind === "label" ? await setLabel(ctx, params.label, params.remove) : await postComment(ctx);
  } catch (e) {
    if (e instanceof NotRun) {
      await markCard(db, id, ["running"], { state: "proposed", acted_by: null, acted_at: null });
      throw new ConversationError(409, e.message);
    }
    error = oneLine(String((e as Error).message ?? e));
  }
  await finish(db, c, params, by, { out, error, note }, deps);
  return { card: await need(db, id), ran: true };
}

/** Stores how the run ended: the card, the follow-up issues its merge holds, the audit row and the thread line, in one transaction. */
async function finish(db: Db, c: CardRow, params: CardParams, by: string, r: { out: Outcome | null; error: string | null; note?: string }, deps: ActDeps): Promise<void> {
  const { out, error, note } = r;
  const who = deps.role ?? "operator";
  const held = out?.held ?? [];
  // Bound to the workflow and the merge approval the press ran under: the issues are dropped when that approval ends before the merge.
  const [flows, editors] = await db.together(() => Promise.all([
    held.length ? listWorkflows(db, { live: true, refs: [{ repo: c.repo, number: c.number }] }) : Promise.resolve([]),
    c.edited_by ? loadAccess(db, [c.edited_by]) : Promise.resolve(new Map<string, { role: string }>()),
  ]));
  const workflow = flows.find((w) => w.id === out?.workflowId);
  // Only text that was posted, and only text no non-operator wrote, goes into the model's block.
  const posted = out && params.kind === "comment" && (!c.edited_by || editors.get(c.edited_by.toLowerCase())?.role === "operator") ? c.text : null;
  const modelNote = deps.noteStaysOut ? undefined : note;
  const data = posted !== null || modelNote ? { ...(posted !== null && { posted_text: posted }), ...(modelNote && { operator_note: modelNote }) } : undefined;
  const end = nowOf(deps).toISOString();
  await db.write(async () => {
    await markCard(db, c.id, ["running", "failed"], { state: out ? "done" : "failed", result: out?.result ?? null, result_url: out?.url ?? null, error, acted_at: end });
    if (held.length) {
      await addHeld(db, held.map((f) => ({ card_id: c.id, workflow_id: out!.workflowId ?? null, approved_at: workflow?.approvedAt ?? null, repo: c.repo, number: c.number, issue_repo: f.repo, title: f.title, body: f.body, by, at: end })));
    }
    await addAudit(db, [{ login: by, action: "conversation-card", target: ref(c.repo, c.number), details: { card: c.id, kind: c.kind, state: out ? "done" : "failed", error: error ?? undefined, ...(note && { note: true }) } }]);
    await insertTurn(db, c.repo, c.number, {
      kind: "system", login: "system", body: (out ? `${by} ran the card: ${c.description}. ${out.result}.` : `${by} tried the card: ${c.description}. It failed: ${error}.`) + (note ? ` Note: ${note}` : ""),
      block: systemBlock(out ? `The ${who} ${by} ran the proposed action: ${c.description}. Result: ${out.result}.` : `The ${who} ${by} tried the proposed action: ${c.description}. It failed: ${error}.`, data),
    }, deps);
  });
}

/** The card runs on a closed item too: a reopen, or a new issue. */
const onClosed = (p: CardParams): boolean => p.kind === "command" && !isRegistry(p.command) && (p.command.word === "reopen" || p.command.word === "open_issue");

/** Ends a queued card that cannot run, with the reason. */
async function failQueued(db: Db, c: CardRow, error: string, deps: StoreDeps): Promise<void> {
  const at = nowOf(deps).toISOString();
  await db.write(async () => {
    if (await failCards(db, [c.id], error, at, "queued") !== 1) return;
    await addAudit(db, [{ login: c.acted_by ?? "system", action: "conversation-card", target: ref(c.repo, c.number), details: { card: c.id, kind: c.kind, state: "failed", error, queued: true } }]);
    await insertTurn(db, c.repo, c.number, { kind: "system", login: "system", body: `${c.acted_by}'s queued card could not run: ${c.description}. ${error}.`, block: systemBlock(`The queued action chosen by ${c.acted_by} could not run: ${c.description}. ${error}.`) }, deps);
  });
}

/**
 * Runs the queued cards that have room, in queue order, as their pressers pressed them (note and role are kept on the card). Stops at the
 * first card that still has no room, so a later one never passes it. A card that cannot run (the presser lost access, the item closed, its
 * repo is not worked) fails with the reason; a transient GitHub error leaves it queued. `writes` is how many GitHub writes the caller still
 * allows (the Act job's limit). Returns the cards run and the writes they were counted for.
 */
export async function drainQueuedCards(db: Db, deps: ActDeps = {}, o: { writes?: number } = {}): Promise<{ ran: number; writes: number }> {
  let ran = 0, used = 0;
  for (const c of (await loadQueue(db, { all: true })).rows) {
    if (!c.acted_by) continue;
    let args: QueueArgs;
    try {
      args = JSON.parse(c.queue_args ?? "{}") as QueueArgs;
    } catch (e) {
      await failQueued(db, c, oneLine(`the queued press cannot be read: ${(e as Error).message}`), deps);
      continue;
    }
    const params = readParams(c.kind, c.params);
    if (!params) { await failQueued(db, c, RETIRED, deps); continue; }
    const need = needOf(c), key = ref(c.repo, c.number);
    const [block, room, items] = await db.together(() => Promise.all([actBlocked(db, c.repo), loadActRoom(db, nowOf(deps)), loadItems(db, [{ repo: c.repo, number: c.number }], "ref")]));
    if (block) { await failQueued(db, c, `Act cannot run for ${c.repo} now: ${block}`, deps); continue; }
    if (!roomFor(room, need) || (o.writes !== undefined && used + need > o.writes)) break;
    const item = items.get(key);
    if (item && item.state !== "OPEN" && !onClosed(params)) { await failQueued(db, c, `the item is already ${item.state.toLowerCase()}`, deps); continue; }
    try {
      const r = await doCard(db, c.id, c.acted_by, { ...deps, drain: true, note: args.note, noteStaysOut: args.noteStaysOut, role: args.role, canWrite: undefined });
      if (r.ran) { ran++; used += need; }
      // Room was taken by someone else between the check and the claim: a smaller card behind this one does not jump it.
      else if (r.card.state === "queued") break;
    } catch (e) {
      if (e instanceof ConversationError && e.status === 503) continue;
      await failQueued(db, c, oneLine(String((e as Error).message ?? e)), deps);
    }
  }
  return { ran, writes: used };
}

/** Whether sweepRunningCards would mark the card failed. */
export const isStaleRunning = (c: Pick<CardRow, "state" | "acted_at">, deps?: StoreDeps): boolean =>
  c.state === "running" && c.acted_at !== null && c.acted_at < new Date(nowOf(deps).getTime() - RUNNING_STALE_MS).toISOString();

/** A card left 'running' by a crashed process is marked failed: what it did on GitHub is unknown. */
export async function sweepRunningCards(db: Db, deps?: StoreDeps): Promise<number> {
  return await sweepCards(db, new Date(nowOf(deps).getTime() - RUNNING_STALE_MS).toISOString());
}
