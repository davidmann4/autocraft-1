// The lines every surface shows for a started item: its steps, the state line, the open recommendation, who started, approved,
// answered or stopped it, its place in line, and the one-line confirmation and reply to each command. GitHub, Discord, the
// agent and the dashboard all build their text here, so the same words appear everywhere. All text goes through t().
import { t, tk } from "../i18n/index.ts";
import type { Ambiguity, Refusal, Resolved, Run } from "./resolve.ts";
import type { Blocker, Entry, ItemWorkflow, Recommendation } from "./types.ts";
import { COMMANDS, ENTRY_LABEL, weightWord } from "./vocab.ts";

export type StepName = "implement" | "review" | "fix-up" | "review again" | "update from main" | "fix CI and conflicts" | "batch" | "merge" | "recommend";
export type StepState = "done" | "running" | "waiting" | "stopped" | "next";
export type Step = {
  name: StepName;
  /** What the step does or did, in a few words: "1 and 2", "no findings". */
  note?: string;
  state: StepState;
};

/** Formats a stored ISO time; the default is `hh:mm UTC`, the dashboard passes the viewer's local time. */
export type Clock = (iso: string) => string;
export const utcClock: Clock = (iso) => (iso.length >= 16 ? `${iso.slice(11, 16)} UTC` : iso);

const ENTRY_STEPS: Record<Entry, StepName[]> = {
  review: ["review"],
  fixup: ["review", "fix-up", "review again"],
  implement: ["implement", "review", "fix-up", "review again"],
  merge: ["update from main", "fix CI and conflicts", "batch", "merge"],
};

/** The steps an entry runs, ending in a merge when approved and in one recommendation when not; the merge queue implies approval. */
export const stepsFor = (entry: Entry, approved: boolean): StepName[] =>
  entry === "merge" ? ENTRY_STEPS.merge : [...ENTRY_STEPS[entry], approved ? "merge" : "recommend"];

/** Steps with states: those before `at` done, `at` in state `now`, the rest next. */
export const stepsAt = (names: StepName[], at: number, now: StepState = "running", notes: Record<number, string> = {}): Step[] =>
  names.map((name, i) => ({ name, ...(notes[i] ? { note: notes[i] } : {}), state: i < at ? "done" : i === at ? now : "next" }));

const STEP_LABEL: Record<StepName, string> = {
  implement: tk("implement"),
  review: tk("review"),
  "fix-up": tk("fix-up"),
  "review again": tk("review again"),
  "update from main": tk("update from main"),
  "fix CI and conflicts": tk("fix CI and conflicts"),
  batch: tk("batch"),
  merge: tk("merge"),
  recommend: tk("come back with a recommendation"),
};
const STATE_LABEL: Record<StepState, string> = { done: tk("done"), running: tk("running"), waiting: tk("waiting"), stopped: tk("stopped"), next: tk("next") };

export const stepLabel = (s: Step): string => (s.note ? t("{step}: {note}", { step: t(STEP_LABEL[s.name]), note: s.note }) : t(STEP_LABEL[s.name]));

/** Where the item's machinery is, as the mirror shows it: the public step, read for the workflow's steps. */
export type Progress = "implementing" | "reviewing" | "fixing" | "waiting-ci" | "queued" | "batched" | "merged" | "other";

/** The index of the step the advance pass recorded on the row, or -1 when it recorded none (a row before its first pass). */
export const recordedStep = (wf: Pick<ItemWorkflow, "step">, names: readonly StepName[]): number =>
  wf.step === null ? -1 : names.indexOf(wf.step as StepName);

/**
 * The workflow's steps with their states: the step the advance pass recorded runs (or waits, or stopped, by the workflow's state),
 * those before it are done. A row with no recorded step yet reads it from where the machinery is.
 */
export function workflowSteps(wf: Pick<ItemWorkflow, "entry" | "kind" | "state" | "approvedBy" | "plan" | "step">, progress: Progress): Step[] {
  const names = stepsFor(wf.entry, wf.approvedBy !== null);
  if (progress === "merged" || wf.state === "done" || wf.state === "closed") return stepsAt(names, names.length);
  const idx = (n: StepName): number => names.indexOf(n);
  const last = names.length - 1;
  let at = recordedStep(wf, names);
  if (at < 0) {
    if (wf.entry === "merge") at = progress === "batched" ? idx("batch") : progress === "fixing" ? idx("fix CI and conflicts") : idx("update from main");
    else if (wf.state === "recommending" && names[last] === "recommend") at = last;
    else if (progress === "implementing" || (wf.kind === "issue" && wf.entry === "implement")) at = idx("implement");
    else if (progress === "fixing") at = idx("fix-up");
    else if (progress === "waiting-ci" || progress === "queued" || progress === "batched") at = last;
    else at = wf.plan.some((p) => p.state === "fixed") && idx("review again") >= 0 ? idx("review again") : idx("review");
  }
  if (at < 0) at = Math.max(0, idx("review"));
  const now: StepState = wf.state === "running" ? "running" : wf.state === "blocked" || wf.state === "stopped" || wf.state === "backlog" ? "stopped" : "waiting";
  return stepsAt(names, at, now);
}

/** One line per step: `2. fix-up: 1 and 2 (running)`. */
export const stepLines = (steps: readonly Step[]): string[] =>
  steps.map((s, i) => t("{n}. {step} ({state})", { n: i + 1, step: stepLabel(s), state: t(STATE_LABEL[s.state]) }));

/** The step that runs, waits or stopped now. */
export const currentStep = (steps: readonly Step[]): Step | undefined => steps.find((s) => s.state === "running" || s.state === "waiting" || s.state === "stopped");

const BLOCKER_LABEL: Record<Blocker, string> = {
  "major-finding": tk("a major finding in the review"),
  "author-commits": tk("new commits from the author"),
  "failed-twice": tk("a step failed twice"),
  "beyond-agreed": tk("work beyond what was agreed"),
  "large-fix": tk("a large fix"),
  "outside-purpose": tk("a change outside the pull request's purpose"),
  other: tk("a stop the review or merge step reported"),
};
export const blockerLabel = (b: Blocker): string => t(BLOCKER_LABEL[b]);

/** "1", "1 and 2", "1, 2 and 3". */
export function listText(ns: readonly (number | string)[]): string {
  if (ns.length < 2) return String(ns[0] ?? "");
  return t("{list} and {last}", { list: ns.slice(0, -1).join(", "), last: String(ns[ns.length - 1]) });
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Where the item stands, in one line. `wait`: what a running item waits for that nothing can move on (waits.ts legWait). */
export function stateLine(wf: ItemWorkflow, current?: Step, clock: Clock = utcClock, wait: string | null = null): string {
  if (wait && (wf.state === "running" || wf.state === "waiting")) return wait;
  switch (wf.state) {
    case "running": return current ? t("Running: {step}", { step: stepLabel(current) }) : t("Running");
    case "waiting": return current ? t("Waiting: {step}", { step: stepLabel(current) }) : t("Waiting");
    case "blocked": return wf.blocker ? t("Stopped at a blocker: {blocker}", { blocker: blockerLabel(wf.blocker) }) : t("Stopped at a blocker");
    case "recommending": return t("Waiting for an answer");
    case "done": return t("Done");
    case "stopped": return wf.stoppedBy ? t("Stopped by {login}, {time}", { login: wf.stoppedBy, time: clock(wf.stoppedAt ?? "") }) : t("Stopped");
    case "closed": return t("Closed");
    case "backlog": return t("In the backlog");
  }
}

const AFTER_CHECKS = (): string => t("after the pre-merge check and green CI");

/**
 * What a bare yes runs for this recommendation, built from its stored fields in the order `accept` (resolve.ts) applies them;
 * null when a yes runs nothing (the recommendation's text says what answers it instead).
 */
export function yesClause(rec: Recommendation): string | null {
  const fix = rec.parts.fix;
  if (rec.close && !fix.length) return t("Reply yes to close it.");
  if (rec.answer && !fix.length) {
    const what = rec.answer.label ? t("go with “{option}”", { option: rec.answer.label }) : t("go on with the implementation");
    return rec.merges ? t("Reply yes to {what}, then merge ({checks}).", { what, checks: AFTER_CHECKS() }) : t("Reply yes to {what}; it comes back to you after.", { what });
  }
  const what = fix.length ? t("fix {parts}", { parts: listText(fix) }) : rec.again === "review" ? t("review it again") : rec.again === "fixup" ? t("fix what the review found") : null;
  if (what) return rec.merges ? t("Reply yes to {what}, then merge ({checks}).", { what, checks: AFTER_CHECKS() }) : t("Reply yes to {what}; it comes back to you after.", { what });
  return rec.merges ? t("Reply yes to merge it ({checks}).", { checks: AFTER_CHECKS() }) : null;
}

/** A recommendation's sentence and what a yes runs; the sentence alone, with a request for words, when a yes runs nothing. */
export const recommendationText = (rec: Recommendation): string =>
  `${rec.text} ${yesClause(rec) ?? t("Reply yes, or write what to do instead.")}`;

/** The open recommendation and how to answer it, or null when none is open. */
export const recommendationLine = (rec: Recommendation | null): string | null =>
  rec ? t("Recommendation: {text}", { text: recommendationText(rec) }) : null;

/** Who started, approved, answered and stopped the item; `answered` is the latest answer, from the item's events. */
export function attributionLines(wf: ItemWorkflow, answered?: { by: string; at: string } | null, clock: Clock = utcClock): string[] {
  const out = [t("{entry}, started by {login}, {time}", { entry: t(ENTRY_LABEL[wf.entry]), login: wf.startedBy, time: clock(wf.startedAt) })];
  if (wf.approvedBy) out.push(t("Approved for merge by {login}, {time}", { login: wf.approvedBy, time: clock(wf.approvedAt ?? "") }));
  if (answered) out.push(t("Answered by {login}, {time}", { login: answered.by, time: clock(answered.at) }));
  if (wf.stoppedBy) out.push(t("Stopped by {login}, {time}", { login: wf.stoppedBy, time: clock(wf.stoppedAt ?? "") }));
  return out;
}

/** The item's place in a queue, counted from 1. */
export const queueLine = (position: number): string => t("#{n} in line", { n: position });

/** The weight as items show it; the normal weight shows nothing. */
export const weightLabel = (w: number | null | undefined): string | null => {
  const word = weightWord(w);
  return word === null ? null : word.startsWith("weight ") ? t("weight {n}", { n: w! }) : t(word);
};

/** "(approved by mira, 09:31 UTC)" */
function byText(how: Run["how"], login: string, time: string): string {
  const p = { login, time };
  switch (how) {
    case "started": return t("(started by {login}, {time})", p);
    case "approved": return t("(approved by {login}, {time})", p);
    case "answered": return t("(answered by {login}, {time})", p);
    case "stopped": return t("(stopped by {login}, {time})", p);
    case "set": return t("(set by {login}, {time})", p);
    default: return t("(by {login}, {time})", p);
  }
}

/**
 * The one-line confirmation of an accepted command, the same on every surface:
 * "Fixing 1 and 2, then merging when CI is green (approved by mira, 09:31 UTC). Reply stop to halt."
 */
export function confirmLine(r: Run, by: string, at: string, clock: Clock = utcClock): string {
  const who = byText(r.how, by, clock(at));
  if (r.end === "stop") return t("Stopped {by}. Nothing more runs.", { by: who });
  if (r.end === "close") return t("Closing {by}.", { by: who });
  if (r.end === "backlog") return t("In the backlog: open, no work planned {by}. Any command starts it again.", { by: who });
  if (r.autorepin !== null) {
    return r.autorepin.toLowerCase() === "off"
      ? t("No Cargo repin after this merges {by}.", { by: who })
      : t("Repinning the Cargo dependencies of {target} when this merges {by}.", { target: r.autorepin, by: who });
  }
  const did: string[] = [];
  if (r.drop.length) did.push(t("dropping {parts}", { parts: listText(r.drop) }));
  if (r.start === "review") did.push(t("reviewing"));
  else if (r.start === "fixup") did.push(t("reviewing, fixing what the review finds, reviewing again"));
  else if (r.start === "implement") did.push(t("implementing, reviewing, fixing what the review finds, reviewing again"));
  else if (r.again === "review") did.push(t("reviewing again"));
  else if (r.again === "fixup") did.push(r.fix.length ? t("fixing {parts}", { parts: listText(r.fix) }) : t("fixing what the review found"));
  if (r.decision) did.push(r.decision.label ? t("going on with “{option}”", { option: r.decision.label }) : t("going on with the implementation"));
  const weight = weightLabel(r.weight);
  if (!did.length && !r.start && !r.approve && !r.answers) {
    // A weight alone.
    const shown = r.weight === null ? null : weightWord(r.weight)?.startsWith("weight ") ? String(r.weight) : weight;
    return t("Weight {weight} {by}.", { weight: shown ?? t("normal"), by: who });
  }
  const end = r.start === "merge"
    ? t("updating from main, then merging in the next batch when CI is green")
    : r.merges
      ? did.length || r.answers ? t("merging when CI is green") : t("merging when the steps are done and CI is green")
      : t("coming back with a recommendation");
  const what = cap(did.length ? t("{done}, then {end}", { done: did.join(", "), end }) : end);
  return t("{what}{weight} {by}. Reply stop to halt.", { what, weight: weight ? `, ${weight}` : "", by: who });
}

/** The reply when nothing ran: what was understood, and why it waits. */
export function replyLine(r: Exclude<Resolved, { kind: "run" }>, clock: Clock = utcClock, mention?: string): string {
  return r.kind === "ambiguous" ? ambiguityText(r.understood, r.ambiguity, mention) : refusalText(r.refusal, clock);
}

/** Words that reverse or postpone a command: a reply holding one is never read back as that command. */
const MEANING_WORDS = /(?<![\w-])(?:don't|dont|do not|not|no|never|wait|hold|later|unless|but|if|instead|n't)(?![\w-])|n't(?![\w-])/i;

/** The one start-or-approve command a leftover text names, or null when it names none, several, or is hedged. */
function singleCommand(rest: string): string | null {
  if (MEANING_WORDS.test(rest)) return null;
  const found = COMMANDS.filter((c) => !c.answer && c.word !== "autorepin" && [c.word, ...c.aliases].some((w) => new RegExp(`(?<![\\w-])${w.replace(/[- ]/g, "[-\\s]?")}(?![\\w-])`, "i").test(rest)));
  return found.length === 1 ? found[0]!.word : null;
}

function ambiguityText(understood: string, a: Ambiguity, mention?: string): string {
  switch (a.why) {
    case "unreadable":
      if (understood && a.rest) return t("I understood “{understood}” but not “{rest}”. Nothing runs until the instruction is clear.", { understood, rest: a.rest });
      if (a.rest) {
        const one = singleCommand(a.rest);
        if (one) return t("I read this as `{command}`. Reply `{reply}` to run it.", { command: one, reply: mention ? `@${mention} yes` : "yes" });
        return t("I couldn't read “{rest}” as a command. Nothing runs until the instruction is clear. Commands: {commands}.", { rest: a.rest, commands: COMMANDS.filter((c) => !c.answer || c.word === "drop").map((c) => c.usage).join(", ") });
      }
      if (understood) return t("I understood “{understood}” but not which items. Nothing runs until the instruction is clear.", { understood });
      return t("There was no command. Nothing runs.");
    case "nothing-to-answer": return t("There is no open recommendation to say yes to. Nothing runs.");
    case "no-plan": return t("“{understood}” names parts of a plan, but this item has no plan yet. Nothing runs.", { understood });
    case "no-such-part": return t("There is no part {n}. Nothing runs until you name one, by number or words.", { n: a.part });
    case "part-matches-none": return t("“{words}” matches no part. Nothing runs until you name one, by number or words.", { words: a.words });
    case "part-matches-several": return t("“{words}” matches parts {parts}. Nothing runs until you name one, by number or words.", { words: a.words, parts: listText(a.parts) });
    case "weight-unstarted": return t("Nothing runs on this item yet. Give the weight with a command, such as “review, {weight}”.", { weight: weightLabel(a.weight) ?? "urgent" });
    case "conflict": return t("“{words}” can't run together. Nothing runs.", { words: a.words.join(", ") });
    case "pick-one": return a.parts.length
      ? t("Name one of {parts} to go with. Nothing runs until you do.", { parts: listText(a.parts) })
      : t("Every option is dropped. Nothing runs: name one to go with, or answer in a comment on the issue.");
    case "needs-words": return t("A yes can't answer this. {text} Nothing runs until then.", { text: a.text });
    case "merge-skips-fixes": return t("“merge” could mean merging without fixing {parts}, or the recommendation. Nothing runs: reply yes for the recommendation, or “drop {parts}, merge” to merge without them.", { parts: listText(a.parts) });
  }
}

function refusalText(r: Refusal, clock: Clock): string {
  switch (r.why) {
    case "implement-not-issue": return t("implement is for issues.");
    case "not-issue-step": return t("{word} is for pull requests. Use implement for an issue.", { word: r.word });
    case "issue-merge-queue": return t("An issue can't go in the merge queue. Use implement and merge.");
    case "autorepin-not-pr": return t("autorepin is for pull requests.");
    case "nothing-running": return t("Nothing is running on this item.");
    case "already-started": return t("Already started: {entry}, by {login}, {time}.", { entry: t(ENTRY_LABEL[r.entry]), login: r.by, time: clock(r.at) });
    case "implement-part": return t("Part {parts} belongs to the plan the implementation is built from. Fix or drop parts of its review, or stop.", { parts: listText(r.parts) });
    case "already-approved": return t("Already approved for merge by {login}, {time}.", { login: r.by, time: clock(r.at) });
  }
}
