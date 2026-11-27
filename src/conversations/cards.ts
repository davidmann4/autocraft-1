// Action cards: what Opus may propose, checked by our code, and the plain lines a person reads. A card is a registered command
// (src/workflow/vocab.ts) that a press runs as the presser, a comment, a label, or a GitHub action that has no command. Opus writes
// resolutions of steps; each step becomes the card that carries it out. Descriptions are built here from the parameters; the model never writes them.
import { ownerOf, splitSlug } from "../owners.ts";
import { REFERENCE_LEAK } from "../review/opus-parse.ts";
import { ALL_LABELS, isTypeLabel, sameLabel } from "../labels/set.ts";
import { LOGIN } from "../access.ts";
import { loadAuthoredIn, loadItems } from "../data/mirror/index.ts";
import { loadPermissions, permKey } from "../data/access/index.ts";
import { loadTrackedRepos } from "../data/control/index.ts";
import { loadQuiet } from "../data/security/index.ts";
import type { NewCard as StoredCard } from "../data/conversations/index.ts";
import { listWorkflows } from "../data/workflow/index.ts";
import { closeText, describe as describeParts, parse } from "../workflow/parse.ts";
import { resolve } from "../workflow/resolve.ts";
import { t } from "../i18n/index.ts";
import type { CloseReason, ItemWorkflow } from "../workflow/types.ts";
import { COMMENT_MAX, ISSUE_TITLE_MAX } from "./types.ts";
import type { Db } from "../db/index.ts";

/** An issue a merging command opens once the PR merged (src/conversations/held.ts). */
export type FollowUp = { repo: string; title: string; body: string };

/** A command of the registry: a press runs `text` through the workflow's runCommand as the presser. */
export type RegistryCommand = {
  /** Registry words as src/workflow/parse.ts reads them, in canonical form ("fix-up, merge"). */
  text: string;
  /** The text approves a merge. */
  merges?: boolean;
  /** The text names plan parts: when the recommendation it names them from was written. Another recommendation refuses the press. */
  parts?: { recAt: string | null };
  /** The item is a pull request (the wording of a close). */
  pr?: boolean;
  followups?: FollowUp[];
};

/** GitHub actions with no registered command: a press makes the write as the presser (act.ts). */
export type OtherAction =
  | { word: "reopen" }
  | { word: "open_issue"; repo: string; title: string; body: string }
  | { word: "transfer"; to: string }
  | { word: "assign"; login: string }
  | { word: "request_reviewers"; logins: string[] };

export type Command = RegistryCommand | OtherAction;

/** The comment card's text is the card's `text`. */
export type CardParams = { kind: "command"; command: Command } | { kind: "comment" } | { kind: "label"; label: string; remove: boolean };

export type NewCard = { params: CardParams; text: string | null; description: string };

export const isRegistry = (c: Command): c is RegistryCommand => "text" in c;

/** The close a command text is, with its reason; null for any other command. */
function closeOf(text: string): { reason: CloseReason | null } | null {
  const p = parse(text);
  const part = p.kind === "commands" ? p.parts.find((x) => x.word === "close") : undefined;
  return part?.word === "close" ? { reason: part.reason ?? null } : null;
}
/** " as not planned", or nothing without a reason. */
const closeSuffix = (r: CloseReason | null): string => (r ? ` ${closeText(r)}` : "");

/** The card as a reply writes it, for the turn Opus reads back. */
export function replyForm(c: NewCard): unknown {
  const p = c.params;
  if (p.kind === "comment") return { kind: "resolution", steps: [{ kind: "comment" }], text: c.text ?? "" };
  if (p.kind === "label") return { kind: "resolution", steps: [{ kind: p.remove ? "unlabel" : "label", label: p.label }] };
  if (isRegistry(p.command)) return { kind: "resolution", steps: [...followupsOf(p).map((f) => ({ kind: "open_issue", ...f })), { kind: "command", text: p.command.text }] };
  const { word, ...rest } = p.command;
  return { kind: "resolution", steps: [{ kind: word, ...rest }] };
}

/** The stored form of a card. */
export const storedCard = (c: NewCard): StoredCard => ({ kind: c.params.kind, params: JSON.stringify(c.params), text: c.text, description: c.description });

/** The card's parameters, or null for a card stored by the retired decision system (or unreadable). */
export function readParams(kind: string, params: string): CardParams | null {
  if (kind !== "command" && kind !== "comment" && kind !== "label") return null;
  try {
    const p = JSON.parse(params) as CardParams;
    return p && typeof p === "object" && p.kind === kind ? p : null;
  } catch { return null; }
}

export const followupsOf = (p: CardParams): FollowUp[] => (p.kind === "command" && isRegistry(p.command) ? p.command.followups ?? [] : []);

/** Whether the press holds issues until the merge: a merging command with follow-ups. */
export const holdsIssues = (p: CardParams): boolean => followupsOf(p).length > 0;

/** The line and the button of the commands proposed most; any other shows its own text. */
const WORDS: Record<string, [line: string, button: string]> = {
  review: ["Review the PR", "Review"],
  "fix-up": ["Fix up the PR", "Fix up"],
  "fix-up, merge": ["Fix up the PR, then merge it if the review and CI pass", "Fix up and merge"],
  merge: ["Approve the merge", "Merge"],
  implement: ["Implement the issue", "Implement"],
  "implement, merge": ["Implement the issue, then merge its PR if the review and CI pass", "Implement and merge"],
  backlog: ["Move the item to the Backlog", "Move to Backlog"],
  stop: ["Stop all work on the item", "Stop"],
};

/** One plain line for a command. */
export function commandLine(c: Command): string {
  if (isRegistry(c)) {
    const close = closeOf(c.text);
    if (close) return `Close the ${c.pr ? "PR" : "issue"}${closeSuffix(close.reason)}`;
    return WORDS[c.text]?.[0] ?? `Run "${c.text}"`;
  }
  switch (c.word) {
    case "reopen": return "Reopen it";
    case "open_issue": return `Open an issue in ${c.repo}: "${c.title}"`;
    case "transfer": return `Move the issue to ${c.to}`;
    case "assign": return `Assign ${c.login}`;
    case "request_reviewers": return `Ask ${c.logins.join(", ")} for a review`;
  }
}

/** What runs, one plain line each. */
export function cardLines(p: CardParams): string[] {
  if (p.kind === "comment") return ["Post the comment below"];
  if (p.kind === "label") return [p.remove ? `Remove the label "${p.label}"` : `Add the label "${p.label}"`];
  return [commandLine(p.command), ...followupsOf(p).map((f) => `After the merge: open an issue in ${f.repo}: "${f.title}"`)];
}

/** The primary button's label. */
export function buttonLabel(p: CardParams): string {
  if (p.kind === "comment") return "Post comment";
  if (p.kind === "label") return p.remove ? "Remove label" : "Add label";
  const c = p.command;
  if (isRegistry(c)) {
    const close = closeOf(c.text);
    if (close) return close.reason?.as === "duplicate" ? "Close as duplicate" : `Close ${c.pr ? "PR" : "issue"}${closeSuffix(close.reason)}`;
    return WORDS[c.text]?.[1] ?? c.text;
  }
  switch (c.word) {
    case "reopen": return "Reopen";
    case "open_issue": return "Open issue";
    case "transfer": return "Move issue";
    case "assign": return "Assign";
    case "request_reviewers": return "Ask for review";
  }
}

/** The card's first line: the button's action with its key parameter. */
export function headline(p: CardParams): string {
  if (p.kind !== "command") return buttonLabel(p);
  const c = p.command;
  if (isRegistry(c)) {
    const close = closeOf(c.text);
    return close?.reason?.as === "duplicate" ? `Close${closeSuffix(close.reason)}` : buttonLabel(p);
  }
  if (c.word === "transfer") return `Move issue to ${c.to}`;
  if (c.word === "open_issue") return `Open issue in ${c.repo}`;
  return buttonLabel(p);
}

/** The GitHub write the command leads to after the press, or null. */
export function cardEffect(p: CardParams): string | null {
  if (p.kind !== "command" || !isRegistry(p.command)) return null;
  if (closeOf(p.command.text)) return p.command.pr ? "closes the PR on GitHub" : "closes the issue on GitHub";
  return p.command.merges ? "merges the PR on GitHub once the review and CI pass" : null;
}

/** The one-line description stored with a card. */
export const describe = (repo: string, n: number, p: CardParams): string => `On ${repo}#${n}: ${cardLines(p).join("; ")}`;

/** Whether the card rests on the code as it was: a drafted public text, a merge, or parts of the plan. Refused after a push until Opus writes it again. */
export const dependsOnCode = (p: CardParams): boolean => p.kind === "comment" || holdsIssues(p)
  || (p.kind === "command" && (isRegistry(p.command) ? !!p.command.merges || !!p.command.parts : p.command.word === "open_issue"));

/** What a press runs, as a person types it; undefined for an action without a registered command. */
export const commandText = (p: CardParams): string | undefined => (p.kind === "command" && isRegistry(p.command) ? p.command.text : undefined);

/** Why a press runs nothing as the item stands, or null. `recAt`: when the item's current recommendation was written. */
export function actionRefusal(p: CardParams, f: { quiet: boolean; recAt: string | null }): string | null {
  const parts = p.kind === "command" && isRegistry(p.command) ? p.command.parts : undefined;
  if (parts && f.recAt !== parts.recAt) return t("The plan changed since this was proposed.");
  if (f.quiet && postsText(p)) return t("This card posts text, and the pull request is quiet until its fix is published.");
  return null;
}

/** Whether the card puts model-written text on GitHub: refused on a quiet pull request until its fix is published. */
export const postsText = (p: CardParams): boolean =>
  p.kind === "comment" || holdsIssues(p) || (p.kind === "command" && !isRegistry(p.command) && (p.command.word === "open_issue" || p.command.word === "transfer"));

/** The repos a card writes to: its item's, and where it moves the item or opens an issue. */
export function cardRepos(repo: string, p: CardParams | null): string[] {
  const more = !p || p.kind !== "command" ? [] : isRegistry(p.command) ? followupsOf(p).map((f) => f.repo) : p.command.word === "transfer" ? [p.command.to] : p.command.word === "open_issue" ? [p.command.repo] : [];
  return [...new Set([repo, ...more])];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", commat: "@", num: "#", lpar: "(", rpar: ")", lsqb: "[", rsqb: "]", lbrack: "[", rbrack: "]", colon: ":", sol: "/", period: ".", excl: "!", bsol: "\\" };

/** Decodes numeric and the common named HTML entities, also when encoded twice (`&amp;#64;`). */
export function decodeEntities(s: string): string {
  let t = s;
  for (let k = 0; k < 5; k++) {
    const next = t.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z][a-z0-9]{1,8}));?/gi, (m, d: string | undefined, h: string | undefined, name: string | undefined) => {
      if (name) return ENTITIES[name.toLowerCase()] ?? m;
      const cp = d ? Number(d) : parseInt(h!, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    });
    if (next === t) break;
    t = next;
  }
  return t;
}

/**
 * Model text for a public comment, cleaned like the Act step's comments: entities decoded first (so `&#64;user` cannot notify),
 * then raw HTML, images, links (Markdown, autolinks and bare URLs, keeping a Markdown link's text), cross-repo references and every
 * @ removed. A person who edits a card may add links back.
 */
export function cleanComment(s: string): string {
  let t = s;
  for (let k = 0; k < 5; k++) {
    const next = decodeEntities(t)
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])/g, "")
      .replace(/\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/g, "$1")
      .replace(/^[ \t]*\[[^\]]+\]:[ \t]*\S+.*$/gm, "")
      .replace(/<\/?[a-z!][^>]*>/gi, "")
      .replace(/<?\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:)[^\s<>]*>?/gi, "")
      .replace(/\b[\w.-]+\/[\w.-]+#\d+/g, "")
      .replace(/[@＠﹫]/g, "");
    if (next === t) break;
    t = next;
  }
  return t.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

// ---- checking what Opus proposed ------------------------------------------------------------------------------------

/** What the checks read about the item and the names a reply mentions, loaded once per reply (loadCardFacts). */
export type CardFacts = {
  repo: string;
  n: number;
  item: { kind: string; state: string; author: string | null; labels: string[] } | null;
  quiet: boolean;
  tracked: ReadonlySet<string>;
  /** The item's live workflow. */
  workflow: ItemWorkflow | null;
  /** State of the repo's items the mirror has, among those asked for. */
  known: ReadonlyMap<number, string>;
  /** Logins (lower case), among those asked for, known to write to the repo: a cached write permission, or an owner, member or collaborator association there. */
  writers: ReadonlySet<string>;
};

export const itemLabels = (i: { labels: string | null }): string[] => {
  try { const l = JSON.parse(i.labels ?? "[]") as unknown; return Array.isArray(l) ? l.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
};

const WRITE = new Set(["write", "maintain", "admin"]);

/** The facts the checks of one item read, in one wave. `numbers` and `logins`: the other items and the people a reply names. */
export async function loadCardFacts(db: Db, repo: string, n: number, want: { numbers?: number[]; logins?: string[] } = {}): Promise<CardFacts> {
  const ref = `${repo}#${n}`;
  const numbers = [...new Set((want.numbers ?? []).filter((x) => Number.isInteger(x) && x > 0 && x !== n))];
  const logins = [...new Set((want.logins ?? []).filter((l) => LOGIN.test(l)).map((l) => l.toLowerCase()))];
  const [items, quiet, tracked, perms, authored, live] = await db.together(() => Promise.all([
    loadItems(db, [{ repo, number: n }, ...numbers.map((number) => ({ repo, number }))], "card"),
    loadQuiet(db, [ref]),
    loadTrackedRepos(db),
    loadPermissions(db, logins.map((login) => ({ login, repo }))),
    loadAuthoredIn(db, repo, logins, ["OWNER", "MEMBER", "COLLABORATOR"]),
    listWorkflows(db, { live: true, refs: [{ repo, number: n }] }),
  ]));
  const it = items.get(ref);
  return {
    repo, n, quiet: quiet.size > 0, tracked: new Set(tracked.keys()),
    item: it ? { kind: it.kind, state: it.state, author: it.author, labels: itemLabels(it) } : null,
    workflow: live.at(-1) ?? null,
    known: new Map(numbers.flatMap((x) => { const i = items.get(`${repo}#${x}`); return i ? [[x, i.state] as const] : []; })),
    writers: new Set(logins.filter((l) => WRITE.has(perms.get(permKey(l, repo))?.permission ?? "") || authored.has(l))),
  };
}

export type Checked<T> = { value: T } | { note: string };

/** Model text for a comment, cleaned and checked. */
export function commentText(raw: unknown, drop: ReadonlySet<string>): Checked<string> {
  const text = typeof raw === "string" ? cleanComment(raw) : "";
  if (!text) return { note: "dropped a resolution whose comment step has no text" };
  if (REFERENCE_LEAK.test(text) || drop.has(text)) return { note: "dropped a resolution whose comment mentions the reference folder or its documentation" };
  if (text.length > COMMENT_MAX) return { note: `dropped a resolution whose comment is longer than ${COMMENT_MAX} characters` };
  return { value: text };
}

/** Model text for an issue title (one line) or body, cleaned like a comment. */
function issueText(raw: unknown, max: number, what: string, drop: ReadonlySet<string>, oneLine: boolean): Checked<string> {
  const t = typeof raw === "string" ? (oneLine ? cleanComment(raw).replace(/\s+/g, " ") : cleanComment(raw)) : "";
  if (!t) return { note: `dropped a resolution whose open_issue step has no ${what}` };
  if (REFERENCE_LEAK.test(t) || drop.has(t)) return { note: `dropped a resolution whose issue ${what} mentions the reference folder or its documentation` };
  if (t.length > max) return { note: `dropped a resolution whose issue ${what} is longer than ${max} characters` };
  return { value: t };
}

/** A repository name as the model wrote it, without a leading `owner/` of the repo's own owner. */
const bareRepo = (v: unknown): unknown => {
  if (typeof v !== "string" || !v.includes("/")) return v;
  const { owner, name } = splitSlug(v);
  return owner.toLowerCase() === ownerOf(name).toLowerCase() ? name : v;
};

const isPr = (f: CardFacts): boolean => f.item?.kind === "pr";
/** A command text longer than this is no command. */
const COMMAND_MAX = 200;

/** The command a text names, checked against the item and its workflow as a press would resolve it now. */
export function registryCommand(f: CardFacts, raw: unknown): Checked<RegistryCommand> {
  const p = typeof raw === "string" && raw.length <= COMMAND_MAX ? parse(raw, { repo: f.repo }) : null;
  if (!p || p.kind !== "commands" || p.items.length) return { note: `dropped a resolution: "${String(raw).slice(0, 60)}" is not a command` };
  const text = describeParts(p.parts);
  if (!isOpen(f)) return { note: `dropped a resolution: ${f.repo}#${f.n} is not open` };
  if (resolve(p, { kind: isPr(f) ? "pr" : "issue", workflow: f.workflow }).kind !== "run") return { note: `dropped a resolution: the command "${text}" does not apply to the item now` };
  const close = p.parts.find((x) => x.word === "close");
  if (close?.word === "close" && close.reason?.as === "duplicate") {
    const { repo, number } = close.reason.of;
    const of = bareRepo(repo);
    if (of === null || of === f.repo) {
      if (number === f.n) return { note: "dropped a resolution whose duplicate names no other item number" };
      if (!f.known.has(number)) return { note: `dropped a resolution: ${f.repo}#${number} is not in the mirror` };
    } else if (typeof of !== "string" || !f.tracked.has(of)) return { note: `dropped a resolution: "${repo}" is not a tracked repository` };
  }
  const merges = p.parts.some((x) => x.word === "merge"), parts = p.parts.some((x) => "part" in x);
  return { value: { text, ...(merges && { merges }), ...(parts && { parts: { recAt: f.workflow?.recAt ?? null } }), ...(isPr(f) && { pr: true }) } };
}

const isOpen = (f: CardFacts): boolean => f.item?.state === "OPEN";
const sameLogin = (a: string | null | undefined, b: string): boolean => !!a && a.toLowerCase() === b.toLowerCase();

/** The managed label the model named, or a note. */
function labelOf(raw: unknown): Checked<string> {
  const l = typeof raw === "string" ? ALL_LABELS.find((x) => sameLabel(x.name, raw)) : undefined;
  return l ? { value: l.name } : { note: `dropped a resolution: "${String(raw).slice(0, 40)}" is not a label the pipeline manages` };
}

/** The type label the item has besides `label` (type labels are exclusive), or null. */
export function otherTypeLabel(have: readonly string[], label: string, removing: readonly string[] = []): string | null {
  if (!isTypeLabel(label)) return null;
  return have.find((l) => isTypeLabel(l) && !sameLabel(l, label) && !removing.some((r) => sameLabel(r, l))) ?? null;
}

/** The step kinds that can pass the checks for the item as it is now (the item block's `steps`). */
export function applicableSteps(f: Pick<CardFacts, "item" | "quiet">): string[] {
  if (f.item?.state === "CLOSED") return ["reopen", "open_issue"];
  if (f.item?.state !== "OPEN") return [];
  const out = ["comment", "label"];
  if (f.item.labels.some((l) => ALL_LABELS.some((x) => sameLabel(x.name, l)))) out.push("unlabel");
  out.push("assign");
  if (f.item.kind === "pr") out.push("request_reviewers");
  out.push("open_issue", "command");
  if (f.item.kind !== "pr") out.push("transfer");
  return f.quiet ? out.filter((k) => k !== "comment" && k !== "open_issue" && k !== "transfer") : out;
}

const MAX_STEPS = 8;

type LabelStep = { kind: "label"; label: string; remove: boolean };
/** A step that names a command, before its text is checked. */
type CommandStep = { command: string };

/** One step as the model wrote it, checked; an open_issue step is a FollowUp until the resolution shows whether it merges. */
function checkStep(f: CardFacts, st: Record<string, unknown>, removing: readonly string[], drop: ReadonlySet<string>): Checked<OtherAction | CommandStep | { kind: "comment" } | LabelStep | FollowUp> {
  const open = isOpen(f), ref = `${f.repo}#${f.n}`;
  switch (st.kind) {
    case "comment": return { value: { kind: "comment" } };
    case "label": case "unlabel": {
      const l = labelOf(st.label);
      if ("note" in l) return l;
      if (!open) return { note: `dropped a resolution: ${ref} is not open` };
      const remove = st.kind === "unlabel";
      const have = f.item?.labels ?? [];
      if (remove && !have.some((x) => sameLabel(x, l.value))) return { note: `dropped a resolution: the item does not have the label "${l.value}"` };
      const other = remove ? null : otherTypeLabel(have, l.value, removing);
      if (other) return { note: `dropped a resolution: the item already has the type label "${other}" and an item has one type label` };
      return { value: { kind: "label", label: l.value, remove } };
    }
    case "close": return { value: { command: st.reason === "completed" ? "close as completed" : st.reason === "not_planned" ? "close as not planned" : "close" } };
    case "duplicate": {
      const of = st.of;
      if (!Number.isInteger(of) || of === f.n) return { note: "dropped a resolution whose duplicate step names no other item number" };
      return { value: { command: `close as duplicate of #${of as number}` } };
    }
    case "command":
      if (typeof st.text !== "string") return { note: "dropped a resolution whose command step has no text" };
      return { value: { command: st.text } };
    case "review": return { value: { command: "review" } };
    case "fixup":
      if (st.merge !== undefined && typeof st.merge !== "boolean") return { note: "dropped a resolution whose fixup merge is not true or false" };
      return { value: { command: st.merge === true ? "fix-up, merge" : "fix-up" } };
    case "reopen":
      if (f.item?.state !== "CLOSED") return { note: `dropped a resolution: ${ref} is not closed` };
      return { value: { word: "reopen" } };
    case "open_issue": {
      const repo = bareRepo(st.repo);
      if (typeof repo !== "string" || !f.tracked.has(repo)) return { note: `dropped a resolution: "${String(st.repo).slice(0, 40)}" is not a tracked repository` };
      const title = issueText(st.title, ISSUE_TITLE_MAX, "title", drop, true);
      if ("note" in title) return title;
      const body = issueText(st.body, COMMENT_MAX, "body", drop, false);
      if ("note" in body) return body;
      return { value: { repo, title: title.value, body: body.value } };
    }
    case "transfer": {
      const to = bareRepo(st.to);
      if (isPr(f)) return { note: "dropped a resolution: only an issue can be moved to another repository" };
      if (typeof to !== "string" || !f.tracked.has(to) || to === f.repo) return { note: `dropped a resolution: "${String(to).slice(0, 40)}" is not another tracked repository` };
      if (ownerOf(to).toLowerCase() !== ownerOf(f.repo).toLowerCase()) return { note: "dropped a resolution: an issue moves only between repositories of one owner" };
      if (!open) return { note: `dropped a resolution: ${ref} is not open` };
      return { value: { word: "transfer", to } };
    }
    case "assign": {
      const login = st.login;
      if (typeof login !== "string" || !LOGIN.test(login)) return { note: "dropped a resolution whose assign step has no GitHub login" };
      if (!sameLogin(f.item?.author, login) && !f.writers.has(login.toLowerCase())) return { note: `dropped a resolution: ${login} is neither the author nor known to have write access to ${f.repo}` };
      return { value: { word: "assign", login } };
    }
    case "request_reviewers": {
      if (!isPr(f)) return { note: "dropped a resolution: reviewers can be requested on a PR only" };
      const raw = st.logins;
      if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3 || raw.some((x) => typeof x !== "string" || !LOGIN.test(x))) return { note: "dropped a resolution whose request_reviewers step does not list one to three GitHub logins" };
      const logins = raw as string[];
      if (new Set(logins.map((x) => x.toLowerCase())).size !== logins.length) return { note: "dropped a resolution that requests the same reviewer twice" };
      const bad = logins.find((x) => sameLogin(f.item?.author, x) || !f.writers.has(x.toLowerCase()));
      if (bad) return { note: `dropped a resolution: ${bad} is the PR's author or not known to have write access to ${f.repo}` };
      return { value: { word: "request_reviewers", logins } };
    }
    default:
      return { note: `dropped a resolution with unknown step "${String(st.kind).slice(0, 40)}"` };
  }
}

const isFollowUp = (v: object): v is FollowUp => "title" in v && "body" in v && !("word" in v);

/**
 * One resolution as the model wrote it, checked against the item, as the cards that carry out its steps (comments and labels first,
 * then the command or action), or why it is dropped. Rules: at most one step of each kind except label and unlabel; one command (review,
 * fixup, close and duplicate steps name one); close, duplicate and transfer end the item and come last; reopen comes first and not with an
 * ending step. An open_issue step of a resolution whose command merges is held until the
 * merge. A settlement of `merge` or `backlog` becomes that command; any other is dropped with a note.
 */
export function validateResolution(f: CardFacts, c: Record<string, unknown>, drop: ReadonlySet<string>, notes: string[]): Checked<NewCard[]> {
  if (!Array.isArray(c.steps) || c.steps.length > MAX_STEPS) return { note: "dropped a resolution without a list of steps" };
  const raws = c.steps.map((x) => (x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : {}));
  const removing = raws.flatMap((x) => (x.kind === "unlabel" && typeof x.label === "string" ? [x.label] : []));
  const kinds = raws.map((x) => String(x.kind));
  const checked: (OtherAction | CommandStep | FollowUp | { kind: "comment" } | LabelStep)[] = [];
  for (const st of raws) {
    const r = checkStep(f, st, removing, drop);
    if ("note" in r) return r;
    checked.push(r.value);
  }
  const count = (k: string) => kinds.filter((x) => x === k).length;
  for (const k of ["comment", "reopen", "open_issue", "assign", "request_reviewers"]) if (count(k) > 1) return { note: `dropped a resolution with more than one ${k} step` };
  const ending = kinds.filter((k) => k === "close" || k === "duplicate" || k === "transfer").length;
  if (ending > 1) return { note: "dropped a resolution that ends the item twice (close, duplicate or transfer)" };
  if (ending === 1 && !["close", "duplicate", "transfer"].includes(kinds[kinds.length - 1]!)) return { note: "dropped a resolution whose close, duplicate or transfer step is not last" };
  if (ending === 1 && (count("review") || count("fixup") || count("command"))) return { note: "dropped a resolution that ends the item and also runs another command" };
  if (count("review") + count("fixup") + count("command") > 1) return { note: "dropped a resolution with more than one command" };
  if (count("reopen") === 1 && (kinds[0] !== "reopen" || ending === 1)) return { note: "dropped a resolution whose reopen step is not first or that also ends the item" };
  const labels = checked.filter((x): x is LabelStep => "kind" in x && x.kind === "label");
  const added = labels.filter((x) => !x.remove).map((x) => x.label), removed = labels.filter((x) => x.remove).map((x) => x.label);
  if (new Set(added).size !== added.length || new Set(removed).size !== removed.length) return { note: "dropped a resolution that adds or removes the same label twice" };
  if (added.filter(isTypeLabel).length > 1) return { note: "dropped a resolution that adds more than one type label" };
  if (added.some((l) => removed.includes(l))) return { note: "dropped a resolution that adds and removes the same label" };
  if (f.quiet && kinds.some((k) => k === "comment" || k === "open_issue" || k === "transfer")) return { note: "dropped a resolution that posts text on a quiet pull request" };
  let text: string | null = null;
  if (count("comment") === 1) {
    const t = commentText(c.text, drop);
    if ("note" in t) return t;
    text = t.value;
  } else if (c.text !== undefined && c.text !== null && c.text !== "") return { note: "dropped a resolution with a comment text but no comment step" };

  const issues = checked.filter((x): x is FollowUp => isFollowUp(x));
  const step = checked.find((x): x is CommandStep => "command" in x);
  const s = c.settle && typeof c.settle === "object" && !Array.isArray(c.settle) ? c.settle as Record<string, unknown> : null;
  let words = step?.command ?? null;
  if (s?.kind === "answer" && s.option === "merge") words = words === null ? "merge" : /\bmerge\b/.test(words) ? words : `${words}, merge`;
  else if (s?.kind === "backlog" && words === null) words = "backlog";
  else if (s) notes.push("dropped a settlement: questions are answered with commands now");
  if (raws.some((x) => x.kind === "fixup" && typeof x.instructions === "string" && x.instructions.trim())) notes.push("dropped a fix-up's instructions: a fix-up makes the fixes of the review");
  const commands: Command[] = checked.filter((x): x is OtherAction => "word" in x);
  if (words !== null) {
    const r = registryCommand(f, words);
    if ("note" in r) return r;
    commands.push({ ...r.value, ...(r.value.merges && issues.length && { followups: issues }) });
  }
  if (!commands.some((x) => isRegistry(x) && x.merges)) commands.push(...issues.map((i): Command => ({ word: "open_issue", ...i })));
  const params: CardParams[] = [
    ...(text !== null ? [{ kind: "comment" } as const] : []),
    ...labels.map((l): CardParams => ({ kind: "label", label: l.label, remove: l.remove })),
    ...commands.map((command): CardParams => ({ kind: "command", command })),
  ];
  if (!params.length) return { note: "dropped a resolution without steps" };
  return { value: params.map((p) => ({ params: p, text: p.kind === "comment" ? text : null, description: describe(f.repo, f.n, p) })) };
}

export type Parsed = { text: string; cards: NewCard[]; notes: string[] };

/** Cards per reply. */
const MAX_CARDS = 8;
const FENCE = /```actions[ \t]*\r?\n([\s\S]*?)```[ \t]*$/;

const listOf = (reply: string): { m: RegExpExecArray | null; list: unknown } => {
  const m = FENCE.exec(reply.trimEnd());
  if (!m) return { m, list: undefined };
  try { return { m, list: JSON.parse(m[1]!) }; } catch { return { m, list: null }; }
};

/** The cleaned text of each public text of a reply (a comment, an issue's title and body), with its field, for the reference checks. */
export function commentTexts(reply: string): { field: string; text: string }[] {
  const { list } = listOf(reply);
  if (!Array.isArray(list)) return [];
  return list.slice(0, 20).flatMap((c: { kind?: unknown; text?: unknown; steps?: unknown }, i) => {
    if (!c || c.kind !== "resolution") return [];
    const out: { field: string; text: string }[] = [];
    const text = typeof c.text === "string" ? cleanComment(c.text) : "";
    if (text) out.push({ field: `cards[${i}].text`, text });
    if (Array.isArray(c.steps)) c.steps.forEach((st: { kind?: unknown; body?: unknown; title?: unknown }, j) => {
      if (!st || st.kind !== "open_issue") return;
      const body = typeof st.body === "string" ? cleanComment(st.body) : "", title = typeof st.title === "string" ? cleanComment(st.title).replace(/\s+/g, " ") : "";
      if (body) out.push({ field: `cards[${i}].steps[${j}].body`, text: body });
      if (title) out.push({ field: `cards[${i}].steps[${j}].title`, text: title });
    });
    return out;
  });
}

/** The item numbers and logins the reply's steps name, so one load reads them all. */
function namesOf(list: unknown[]): { numbers: number[]; logins: string[] } {
  const numbers: number[] = [], logins: string[] = [];
  for (const c of list) {
    const steps = (c as { steps?: unknown } | null)?.steps;
    if (!Array.isArray(steps)) continue;
    for (const st of steps as Record<string, unknown>[]) {
      if (!st || typeof st !== "object") continue;
      if (st.kind === "duplicate" && typeof st.of === "number") numbers.push(st.of);
      if (st.kind === "command" && typeof st.text === "string" && st.text.length <= COMMAND_MAX) {
        const r = closeOf(st.text)?.reason;
        if (r?.as === "duplicate") numbers.push(r.of.number);
      }
      if (st.kind === "assign" && typeof st.login === "string") logins.push(st.login);
      if (st.kind === "request_reviewers" && Array.isArray(st.logins)) logins.push(...st.logins.filter((x): x is string => typeof x === "string"));
    }
  }
  return { numbers, logins };
}

/** The reply's text and its cards, checked against `f`. A reply with no text gets null. `drop`: cleaned texts the reply lint still flagged; their resolutions are dropped. */
export function parseReplyWith(f: CardFacts, reply: string, drop: ReadonlySet<string> = new Set()): Parsed | null {
  const { m, list } = listOf(reply);
  const text = (m ? reply.trimEnd().slice(0, m.index) : reply).trim();
  if (!text) return null;
  const notes: string[] = [];
  const cards: NewCard[] = [];
  if (m && !Array.isArray(list)) notes.push("dropped the actions block: it is not a JSON list");
  else if (Array.isArray(list)) {
    const seen = new Set<string>();
    for (const raw of list.slice(0, 20)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) { notes.push("dropped a card that is not an object"); continue; }
      const c = raw as Record<string, unknown>;
      if (c.kind !== "resolution") { notes.push(`dropped a card with unknown action "${String(c.kind).slice(0, 40)}"`); continue; }
      const v = validateResolution(f, c, drop, notes);
      if ("note" in v) { notes.push(v.note); continue; }
      for (const card of v.value) {
        const key = card.params.kind === "command" ? `command:${isRegistry(card.params.command) ? card.params.command.text : card.params.command.word}` : card.params.kind === "label" ? `label:${card.params.label.toLowerCase()}` : `comment:${card.text}`;
        if (seen.has(key)) { notes.push(`dropped a second card that does the same: ${card.description}`); continue; }
        if (cards.length >= MAX_CARDS) { notes.push(`dropped the cards beyond the ${MAX_CARDS}th`); break; }
        seen.add(key);
        cards.push(card);
      }
    }
    if (list.length > 20) notes.push("dropped the cards beyond the twentieth");
  }
  return { text, cards, notes };
}

/** parseReplyWith over the facts of the item and of the names the reply mentions, loaded in one wave. */
export async function parseReply(db: Db, repo: string, n: number, reply: string, drop: ReadonlySet<string> = new Set()): Promise<Parsed | null> {
  const { list } = listOf(reply);
  return parseReplyWith(await loadCardFacts(db, repo, n, Array.isArray(list) ? namesOf(list) : {}), reply, drop);
}
