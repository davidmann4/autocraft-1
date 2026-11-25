// The command core: every surface (GitHub, Discord, the agent, the dashboard, the CLI) parses text with parse.ts and hands the
// result here. For each item it checks the repo is on the maintainer workflow and that the person may act (src/settlers.ts
// actRefusal), resolves the text against the item's workflow (resolve.ts), carries the run out on the existing machinery
// (effects.ts), writes the workflow row and its event (store.ts) and returns the line every surface shows (status.ts).
//
// A list of items runs item by item: one that is refused or fails leaves the others running, and the reply lists it. GitHub takes
// one item per comment. Each person has an hourly number of items per surface, counted from the recorded events so every
// process and replica shares it.
import { t } from "../i18n/index.ts";
import { parseTripKey } from "../core/push-outcome.ts";
import type { Db } from "../db/index.ts";
import type { Exec } from "../fixup/git.ts";
import { ownerOf, slugOf } from "../owners.ts";
import { actRefusal, type ActRefusal } from "../settlers.ts";
import { prOf } from "./advance.ts";
import * as fx from "./effects.ts";
import { isLive, resolve, type Run } from "./resolve.ts";
import { confirmLine, listText, replyLine, stepsFor, utcClock, type Clock } from "./status.ts";
import { addEvent, insertWorkflow, liveWorkflow, repoWorkflow, updateWorkflow, type WorkflowPatch } from "./store.ts";
import { WEIGHT_NORMAL, type ItemKind, type ItemRef, type ItemWorkflow, type Parsed, type Surface, type WorkflowEventKind } from "./types.ts";

/** Who sent the command. `canWrite` reads the person's live write permission on a repo; `githubId` is needed by autorepin only. */
export type Actor = { login: string | null; canWrite: (repo: string) => Promise<boolean>; githubId?: number | null };

export type CommandInput = {
  parsed: Parsed;
  /** The item the text was written on (or the items a panel selected); a list in the text takes their place. */
  items: ItemRef[];
  /** The only head the command may act on, for a single PR: the head when the comment was written. */
  head?: string;
  /** Repos the sender may see; any other reads as untracked. */
  visible?: (repo: string) => Promise<boolean>;
  at?: string;
  exec?: Exec;
  clock?: Clock;
  /** The app's mention name, for replies that tell the sender what to write back. */
  mention?: string;
};

export type ItemOutcome = { repo: string; number: number; outcome: "run" | "ambiguous" | "refused"; line: string; workflowId: number | null };
export type CommandResult = { items: ItemOutcome[]; lines: string[] };

/** Items a person may send per hour on each surface; the CLI runs on the box and has none. */
export const COMMAND_LIMITS: Record<Surface, number> = { dashboard: 200, agent: 200, discord: 60, github: 30, cli: Number.POSITIVE_INFINITY };
const HOUR_MS = 3_600_000;

const refText = (repo: string, n: number): string => `${slugOf(repo)}#${n}`;

function refusalLine(r: ActRefusal, login: string | null, repo: string): string {
  switch (r) {
    case "no-login": return login ? t("{login} has no AutoCraft login. Sign in to AutoCraft to send commands.", { login }) : t("Sign in to AutoCraft to send commands.");
    case "no-role": return t("Only maintainers and operators send commands to AutoCraft.");
    case "no-write": return t("{login} has no write access to {repo}.", { login: login ?? "", repo: slugOf(repo) });
    case "box-identity": return t("Commands wait until AutoCraft acts on GitHub as the person, through the GitHub App.");
  }
}

/** The tracked repo a command names (`name` or `owner/name`), or null. */
async function trackedRepo(db: Db, written: string): Promise<string | null> {
  const [owner, name] = written.includes("/") ? written.split("/", 2) as [string, string] : [null, written];
  const row = await db.get(db.k.selectFrom("main.tracked_repos").select("name").where("name", "=", name));
  if (!row) return null;
  return owner === null || owner.toLowerCase() === ownerOf(row.name).toLowerCase() ? row.name : null;
}

/** How many command items `login` sent on `via` in the last hour. */
async function sentLastHour(db: Db, login: string, via: Surface, nowMs: number): Promise<number> {
  const r = await db.get(db.k.selectFrom("main.workflow_events").select((eb) => eb.fn.countAll<number>().as("n"))
    .where("login", "=", login).where("via", "=", via).where("at", ">", new Date(nowMs - HOUR_MS).toISOString()));
  return Number(r?.n ?? 0);
}

/** Runs parsed text from `actor` on each item, and returns one outcome and line per item. */
export async function runCommand(db: Db, actor: Actor, via: Surface, input: CommandInput): Promise<CommandResult> {
  const at = input.at ?? new Date().toISOString();
  const p = input.parsed;
  const targets = p.kind !== "ambiguous" && p.items?.length ? p.items : input.items;
  const all = (line: string): CommandResult => ({ items: targets.map((x) => ({ repo: x.repo, number: x.number, outcome: "refused", line, workflowId: null })), lines: [line] });
  if (!targets.length) return { items: [], lines: [t("Name an item for the command.")] };
  if (via === "github" && targets.length > 1) return all(t("One item per comment on GitHub. Send a list from the dashboard, Discord or your agent."));
  if (actor.login && await sentLastHour(db, actor.login, via, Date.parse(at)) + targets.length > COMMAND_LIMITS[via]) {
    return all(t("Too many commands from {login} in the last hour. Try again later.", { login: actor.login }));
  }
  const items: ItemOutcome[] = [];
  for (const target of targets) items.push(await runOne(db, actor, via, input, target, at));
  const many = items.length > 1;
  const lines = items.map((o) => (many ? t("{ref}: {line}", { ref: refText(o.repo, o.number), line: o.line }) : o.line));
  const failed = items.filter((o) => o.outcome !== "run");
  if (many && failed.length) lines.push(t("Not run: {refs}.", { refs: listText(failed.map((o) => refText(o.repo, o.number))) }));
  return { items, lines };
}

async function runOne(db: Db, actor: Actor, via: Surface, input: CommandInput, target: ItemRef, at: string): Promise<ItemOutcome> {
  const repo = await trackedRepo(db, target.repo);
  const out = (outcome: ItemOutcome["outcome"], line: string, workflowId: number | null = null): ItemOutcome =>
    ({ repo: repo ?? target.repo, number: target.number, outcome, line, workflowId });
  if (!repo || (input.visible && !await input.visible(repo))) return out("refused", t("{repo} is not a repository AutoCraft tracks.", { repo: target.repo }));
  if (await repoWorkflow(db, repo) !== "new") return out("refused", t("AutoCraft commands are not switched on for {repo}.", { repo: slugOf(repo) }));
  const no = await actRefusal(db, actor, repo);
  if (no) return out("refused", refusalLine(no, actor.login, repo));
  const login = actor.login!;
  const ref = refText(repo, target.number);
  const it = await db.get(db.k.selectFrom("main.items").select(["kind", "state", "head_oid"]).where("repo", "=", repo).where("number", "=", target.number));
  if (!it) return out("refused", t("{ref} is not an item AutoCraft has read.", { ref }));
  if (it.state !== "OPEN") return out("refused", t("{ref} is not open.", { ref }));
  const kind = it.kind as ItemKind;
  const head = input.head ?? it.head_oid ?? null;
  if (input.head !== undefined && it.head_oid !== input.head) return out("refused", t("{ref} changed after the command was written. Send it again.", { ref }));

  const wf = await liveWorkflow(db, repo, target.number);
  const r = resolve(input.parsed, { kind, workflow: wf });
  const event = (kind: WorkflowEventKind, workflowId: number | null, line: string) =>
    addEvent(db, { workflowId, repo, number: target.number, login, via, kind, parsed: input.parsed, line, at });
  if (r.kind === "ambiguous") {
    const line = replyLine(r, input.clock, input.mention);
    await event("ambiguous", wf?.id ?? null, line);
    return out("ambiguous", line, wf?.id ?? null);
  }
  if (r.kind === "refused") return out("refused", replyLine(r, input.clock, input.mention), wf?.id ?? null);

  const c: fx.Ctx = { db, by: login, via, at, item: { repo, number: target.number, kind, head }, ...(input.exec ? { exec: input.exec } : {}) };
  try {
    const done = await carryOut(c, r.run, isLive(wf) ? wf : null, actor);
    const line = confirmLine(r.run, login, at, input.clock ?? utcClock) + (done.failed.length ? ` ${t("Could not stop: {what}.", { what: done.failed.join("; ") })}` : "")
      + (done.note ? ` ${done.note}` : "");
    await event(eventKind(r.run), done.workflowId, line);
    return out("run", line, done.workflowId);
  } catch (e) {
    if (!(e instanceof fx.EffectError)) throw e;
    return out("refused", t("Nothing ran on {ref}: {why}", { ref, why: e.message }), wf?.id ?? null);
  }
}

function eventKind(r: Run): WorkflowEventKind {
  if (r.end === "stop") return "stopped";
  if (r.end === "close") return "closed";
  if (r.end === "backlog") return "backlog";
  if (r.autorepin !== null) return "set";
  if (r.start) return "started";
  // An answer to the open recommendation is an answer also when it approves the merge: it accepts what the recommendation showed.
  if (r.answers) return "answered";
  if (r.approve) return "approved";
  if (r.weight !== null && !r.again && !r.fix.length && !r.drop.length) return "weighted";
  return "set";
}

type Done = { workflowId: number | null; failed: string[]; note?: string };

/** Runs the resolved command on the machinery, then writes the workflow row. */
async function carryOut(c: fx.Ctx, r: Run, wf: ItemWorkflow | null, actor: Actor): Promise<Done> {
  const { db, by, at, via, item } = c;
  const wfId = wf?.id ?? null;
  const ended = async (state: "stopped" | "closed" | "backlog", failed: string[]): Promise<Done> => {
    if (wf) await updateWorkflow(db, wf.id, { state, ...(state === "stopped" ? { stoppedBy: by, stoppedAt: at } : {}), rec: null, blocker: null, blockerParams: null }, at);
    return { workflowId: wfId, failed };
  };
  const cw: fx.Ctx = wf ? { ...c, workflowId: wf.id } : c;
  if (r.end === "stop") return await ended("stopped", await fx.stopAll(cw));
  if (r.end === "close") return await ended("closed", await fx.close(cw));
  if (r.end === "backlog") return await ended("backlog", await fx.backlog(cw));
  if (r.autorepin !== null) {
    const githubId = actor.githubId ?? (await db.get(db.k.selectFrom("main.access").select("github_id").where("login", "=", by)))?.github_id ?? null;
    await fx.autorepin(c, r.autorepin, githubId);
    return { workflowId: wfId, failed: [] };
  }

  if (r.start) {
    const weight = r.weight ?? WEIGHT_NORMAL;
    const { preapproval } = await fx.start(c, r.start, r.approve, weight);
    const id = await db.write(async () => {
      const id = await insertWorkflow(db, {
        repo: item.repo, number: item.number, kind: item.kind, entry: r.start!, weight, state: "running", startedBy: by, startedAt: at, startedVia: via, baseHead: item.head,
        step: stepsFor(r.start!, r.approve)[0]!,
        ...(r.approve ? { approvedBy: by, approvedAt: at, approvedVia: via } : {}),
      }, at);
      if (preapproval !== null) await db.run(db.k.updateTable("main.preapprovals").set({ workflow_id: id }).where("id", "=", preapproval));
      return id;
    });
    return { workflowId: id, failed: [] };
  }

  // A started item: weight, an answer, a step again, approval.
  const live = wf!;
  const patch: WorkflowPatch = {};
  if (r.weight !== null && r.weight !== live.weight) {
    await fx.storeWeight(c, r.weight);
    patch.weight = r.weight;
  }
  const runs = r.again !== null || r.fix.length > 0 || r.approve || r.answers;
  // An implement workflow's steps after the implementation run on its PR: a review again, fix-ups of the review's parts, the merge leg.
  let on = c;
  if (live.kind === "issue" && !r.decision && (r.again !== null || r.fix.length > 0 || r.merges)) {
    const pr = await implementationPr(db, live);
    // An answer to a recommendation made at another head of the PR would run on code nobody was shown.
    if (pr && live.rec && live.recHead && pr.head !== live.recHead) throw new fx.EffectError(t("The pull request changed after the command was written. Send it again."));
    if (pr) on = { ...c, item: pr, workflowId: live.id };
    else if (r.again !== null || r.fix.length) throw new fx.EffectError(t("{ref} has no open implementation pull request yet.", { ref: refText(item.repo, item.number) }));
  }
  let preapproval: number | null = null;
  if (r.decision) await fx.answerQuestion(c, r.decision.decision, r.decision.option);
  if (runs) preapproval = (await fx.again(on, { again: r.again, plan: live.plan, fix: r.fix, merges: r.merges })).preapproval;
  if (r.drop.length) patch.plan = live.plan.map((p) => (r.drop.includes(p.n) ? { ...p, state: "dropped" as const } : p));
  // An answered question's options are no plan any more.
  if (r.decision) patch.plan = live.plan.filter((p) => p.question !== r.decision!.decision);
  // Approving at this head: commits the person could see are no longer new (blocker 2 counts from here).
  if (r.approve) Object.assign(patch, { approvedBy: by, approvedAt: at, approvedVia: via, ...(item.head ? { baseHead: item.head } : {}) });
  // The person answered at this head: commits they could see are no longer new (blocker 2 counts from here).
  if (r.answers) Object.assign(patch, { rec: null, recAt: null, recHead: null, blocker: null, blockerParams: null, ...(item.head ? { baseHead: item.head } : {}) });
  if (runs) patch.state = r.again !== null || r.merges || r.decision ? "running" : r.answers ? "done" : live.state;
  // The recorded step is the advance pass's; until its next pass, readers work the step out from the new state.
  if (patch.state !== undefined && patch.state !== live.state) patch.step = null;
  await db.write(async () => {
    await updateWorkflow(db, live.id, patch, at);
    if (preapproval !== null) await db.run(db.k.updateTable("main.preapprovals").set({ workflow_id: live.id }).where("id", "=", preapproval).where("workflow_id", "is", null));
  });
  return { workflowId: live.id, failed: [] };
}

/** The open implementation PR of an implement workflow, with its head; null while the issue has none. */
async function implementationPr(db: Db, w: ItemWorkflow): Promise<fx.Target | null> {
  const pr = await prOf(db, w);
  if (!pr || pr.number < 0) return null;
  const it = await db.get(db.k.selectFrom("main.items").select(["state", "head_oid"]).where("repo", "=", w.repo).where("number", "=", pr.number));
  return it?.state === "OPEN" ? { repo: w.repo, number: pr.number, kind: "pr", head: it.head_oid } : null;
}

// ---- controls ------------------------------------------------------------------------------------------------------------

/** A registered control and what it acts on. Task Runner settings belong to the person and have their own page. */
export type ControlInput =
  | { control: "hold-merge" | "release-merge" | "release-outside"; item: ItemRef }
  | { control: "resume-breaker"; key: string }
  | { control: "set-automatic"; repo: string; on: boolean };

/**
 * Runs a control under the act rule of its repo; a repo on the decision pipeline refuses, as commands do. A breaker without a
 * repo (the outside-surge breaker) is instance-wide, so only an operator resumes it.
 */
export async function runControl(db: Db, actor: Actor, via: Surface, input: ControlInput): Promise<{ ok: boolean; line: string }> {
  const written = input.control === "resume-breaker" ? parseTripKey(input.key)?.repo ?? null : input.control === "set-automatic" ? input.repo : input.item.repo;
  const login = actor.login ?? "";
  if (written === null) {
    const role = actor.login ? (await db.get(db.k.selectFrom("main.access").select("role").where("login", "=", actor.login)))?.role : undefined;
    if (role !== "operator") return { ok: false, line: t("Only an operator resumes an instance-wide breaker.") };
    return await controlStep(() => fx.resumeBreaker(db, login, (input as { key: string }).key), t("Resumed {key} (by {login}).", { key: (input as { key: string }).key, login }));
  }
  const repo = await trackedRepo(db, written);
  if (!repo) return { ok: false, line: t("{repo} is not a repository AutoCraft tracks.", { repo: written }) };
  if (await repoWorkflow(db, repo) !== "new") return { ok: false, line: t("AutoCraft commands are not switched on for {repo}.", { repo: slugOf(repo) }) };
  const no = await actRefusal(db, actor, repo);
  if (no) return { ok: false, line: refusalLine(no, actor.login, repo) };
  const at = new Date().toISOString();
  switch (input.control) {
    case "resume-breaker":
      return await controlStep(() => fx.resumeBreaker(db, login, input.key), t("Resumed {key} (by {login}).", { key: input.key, login }));
    case "set-automatic":
      return await controlStep(() => fx.setAutomatic(db, login, repo, input.on), input.on
        ? t("Automatic work is on for {repo} (by {login}).", { repo: slugOf(repo), login })
        : t("Automatic work is off for {repo} (by {login}).", { repo: slugOf(repo), login }));
    default: {
      const ref = refText(repo, input.item.number);
      const it = await db.get(db.k.selectFrom("main.items").select(["kind", "head_oid"]).where("repo", "=", repo).where("number", "=", input.item.number));
      if (!it) return { ok: false, line: t("{ref} is not an item AutoCraft has read.", { ref }) };
      const c: fx.Ctx = { db, by: login, via, at, item: { repo, number: input.item.number, kind: it.kind as ItemKind, head: it.head_oid } };
      if (input.control === "hold-merge") return await controlStep(() => fx.hold(c), t("{ref} is held out of the next merge (by {login}).", { ref, login }));
      if (input.control === "release-merge") return await controlStep(() => fx.release(c), t("{ref} can merge again (by {login}).", { ref, login }));
      return await controlStep(() => fx.releaseHeld(c), t("{ref} is released from its author's hold (by {login}).", { ref, login }));
    }
  }
}

async function controlStep(fn: () => Promise<unknown>, line: string): Promise<{ ok: boolean; line: string }> {
  try {
    await fn();
    return { ok: true, line };
  } catch (e) {
    if (!(e instanceof fx.EffectError)) throw e;
    return { ok: false, line: t("Nothing changed: {why}", { why: e.message }) };
  }
}
