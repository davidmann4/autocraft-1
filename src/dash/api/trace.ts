// The item trace: every event of one GitHub item, oldest first, from the tables that hold per-item history.
// Each source is a small function that returns events for the item through an index on (repo, number) or a
// key derived from it; the list carries no bodies. A source also keeps the fields its detail view shows.
import { createHash } from "node:crypto";
import type { ItemTrace, ItemTraceDetail, ItemTraceHeader, TraceActor, TraceEvent, TraceKind } from "../../../web/src/api/types.ts";
import { GITHUB_ACTIONS } from "../../github/actions.ts";
import { knownStep } from "../../runner/steps.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { AUDIT_ACTIONS, operatorOnly } from "./admin.ts";
import { detailOf } from "./github-detail.ts";
import { canSeeInternals } from "./staff.ts";
import { blankIfHidden, hiddenRepos, needVisible } from "./visible.ts";
import { reasonsFor, waitFor, type Reader } from "./reader.ts";
import type { HiddenRepos } from "../../hidden-sql.ts";
import { isOwnLogin, ownLogins } from "../../github/identity.ts";
import type { Db } from "../../db/index.ts";
import { setting } from "../../data/control/index.ts";
import { loadQuiet } from "../../data/security/index.ts";
import { loadShown } from "../../data/mirror/index.ts";
import { loadItemTrace, loadItemTraceStamp, type ItemTraceRows } from "../../data/views/trace.ts";
import type { AuditRow } from "../../data/control/types.ts";
import { openMentions, type ItemMention } from "./discord.ts";

export type Ev = TraceEvent & { detail?: Record<string, unknown> };
/** `staff`: operators and maintainers; `hidden`: repos the viewer may not see, whose runs are left out like getRun does. */
export type Ctx = { db: Db; repo: string; n: number; ref: string; own: Set<string>; box: string; staff: boolean; /** A quiet pull request seen by a viewer: model output stays out of the trace. */ veiled: boolean; operator: boolean; hidden: HiddenRepos };

export const TRACE_PAGE_DEFAULT = 100, TRACE_PAGE_MAX = 500;
export const KINDS: TraceKind[] = ["github", "plan", "job", "model-call", "check", "review", "decision", "write", "step", "conversation", "discord"];

export const humanize = (id: string): string => { const t = id.replace(/[-_]+/g, " ").trim(); return t.charAt(0).toUpperCase() + t.slice(1); };
/** A step's name as the dashboard shows it. */
export const stepTitle = (id: string): string => knownStep(id)?.title ?? humanize(id);
export const step = (name: string): TraceActor => ({ type: "step", name: name === "AutoCraft" ? name : stepTitle(name) });
export const person = (name: string | null | undefined): TraceActor => ({ type: "person", name: name || "unknown" });
export const model = (name: string | null | undefined, fallback: string): TraceActor => ({ type: "model", name: name || fallback });
export const clip = (s: string | null | undefined, n = 140): string => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const json = <T>(s: unknown, fallback: T): T => { if (s !== null && typeof s === "object") return s as T; try { return typeof s === "string" && s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; } };
export const arr = <T = unknown>(s: unknown): T[] => { const v = json<unknown>(s, []); return Array.isArray(v) ? (v as T[]) : []; };
export const obj = (s: unknown): Record<string, unknown> => { const v = json<unknown>(s, {}); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; };
/** One format for every time, so mixed formats sort right; null when it is not a time. */
export const iso = (at: unknown): string | null => { const t = typeof at === "string" ? Date.parse(at) : NaN; return Number.isNaN(t) ? null : new Date(t).toISOString(); };
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : /(s|x|z|ch|sh)$/.test(w) ? "es" : "s"}`;
const count = (xs: unknown[]): string => plural(xs.length, "finding");

export type ItemRow = { kind: string | null; author: string | null; created_at: string | null; closed_at: string | null; merged_at: string | null; merged_by: string | null; head_oid: string | null };
export const openedEvent = (it: ItemRow): Ev => ({ id: "gh:opened", kind: "github", at: it.created_at ?? "", head: null, actor: person(it.author), summary: `Opened ${it.kind === "pr" ? "pull request" : "issue"} on GitHub${it.author ? ` by ${it.author}` : ""}`, ref: {} });
export const mergedEvent = (it: ItemRow): Ev => ({ id: "gh:merged", kind: "github", at: it.merged_at ?? "", head: it.head_oid, actor: person(it.merged_by), summary: `Merged on GitHub${it.merged_by ? ` by ${it.merged_by}` : ""}`, ref: {} });
export const closedEvent = (it: ItemRow): Ev => ({ id: "gh:closed", kind: "github", at: it.closed_at ?? "", head: null, actor: person(null), summary: "Closed on GitHub", ref: {} });
/** Longest comment text a trace event carries. */
export const TRACE_BODY_MAX = 20_000;
/** `body`, when given, is the stored text (the item trace selects it; the activity feed does not, to keep its pages light). */
export const commentEvent = (c: { id: string; kind: string | null; author: string | null; created_at: string; review_state: string | null; commit_oid: string | null; len: number; body?: string | null; cut?: boolean | 0 | 1 | null }, own: Set<string>): Ev => {
  const ours = isOwnLogin(own, c.author);
  const what = c.kind === "review" ? `review (${(c.review_state ?? "commented").toLowerCase().replace("_", " ")})` : "comment";
  return {
    id: `comment:${c.id}`, kind: "github", at: c.created_at, head: c.commit_oid, actor: ours ? step("AutoCraft") : person(c.author),
    summary: `${ours ? "AutoCraft posted a" : "Posted a"} ${what}, ${c.len} characters`, ref: { commentId: c.id },
    ...(c.body && { body: c.body, ...(c.cut && { bodyCut: true }) }),
  };
};
export const activityEvent = (a: { id: string; kind: string; at: string; actor: string | null; label: string | null; after_oid: string | null; before_oid: string | null }, own: Set<string>): Ev => {
  const ours = isOwnLogin(own, a.actor);
  const summary = a.kind === "force-push" ? `Force-pushed ${(a.before_oid ?? "").slice(0, 7)} → ${(a.after_oid ?? "").slice(0, 7)}` : `${a.kind === "labeled" ? "Added" : "Removed"} label ${a.label ?? ""}`;
  return { id: `activity:${a.id}`, kind: "github", at: a.at, head: a.kind === "force-push" ? a.after_oid : null, actor: ours ? step("AutoCraft") : person(a.actor), summary, ref: a.after_oid ? { head: a.after_oid } : {} };
};


export const stageEvent = (s: { rowid: number; stage: string; at: string; actor: string | null; note: string | null }): Ev =>
  ({ id: `stage:${s.rowid}`, kind: "plan", at: s.at, head: null, actor: step(s.actor || "pipeline"), summary: `Stage ${s.stage}${s.note ? `: ${clip(s.note)}` : ""}`, ref: {} });


export const planEvent = (p: { id: number | string; head: string | null; old_state: string | null; new_state: string; wait: string | null; reasons: string; at: string }): Ev => ({
  id: `plan:${p.id}`, kind: "plan", at: p.at, head: p.head, actor: step("planner"),
  summary: `Plan ${p.old_state ? `${p.old_state} → ` : "started as "}${p.new_state}${p.wait ? `, waiting for ${clip(p.wait, 80)}` : ""}`,
  ref: p.head ? { head: p.head } : {}, detail: { from: p.old_state, to: p.new_state, wait: p.wait, reasons: arr<string>(p.reasons) },
});

/** `planEvent` for one reader: the wait and reasons without items of repos hidden from them (src/dash/api/reader.ts). */
export const planEventFor = (r: Pick<Reader, "staff" | "hidden">, p: Parameters<typeof planEvent>[0]): Ev =>
  planEvent({ ...p, wait: waitFor(r, p.wait), reasons: JSON.stringify(reasonsFor(r, arr<string>(p.reasons))) });


export const jobEvent = (j: { id: number; job_id: number; outcome: string | null; at: string; step: string | null; state: string | null; error: string | null }): Ev => ({
  id: `job:${j.id}`, kind: "job", at: j.at, head: null, actor: step(j.step ?? "job"),
  summary: `${j.step ? stepTitle(j.step) : "Job"}: ${clip(j.outcome) || j.state || "ran"}`, ref: { jobId: j.job_id }, detail: { step: j.step, state: j.state, outcome: j.outcome, error: j.error },
});



/** Prompts whose calls are named by what they do, not by the step that makes them. */
const PROMPT_TITLES: Record<string, string> = { "lint.reference.jev": "Reference lint", "lint.reference.haiku": "Reference lint" };


export const runEvent = (r: { id: number; step: string; prompt_id: string; model: string; provider: string; state: string; started_at: string; ended_at: string | null; input_tokens: number | null; output_tokens: number | null;
  cost_usd: number | null; summary: string | null; label: string | null; tools: number; job_id: number | null; user_login?: string | null; harness?: string | null; reported_model?: string | null }, staff = false): Ev => ({
  id: `run:${r.id}`, kind: "model-call", at: r.started_at, head: null, actor: model(r.model, "model"),
  summary: `${PROMPT_TITLES[r.prompt_id] ?? stepTitle(r.step)}: ${r.state === "running" ? "running" : r.state === "failed" ? "failed" : clip(r.summary, 100) || "done"}`,
  ref: { runId: r.id, ...(r.job_id !== null ? { jobId: r.job_id } : {}) },
  call: { promptId: r.prompt_id, step: stepTitle(r.step), model: r.model, provider: r.provider, state: r.state, inputTokens: r.input_tokens, outputTokens: r.output_tokens, costUsd: r.cost_usd, toolCalls: r.tools, endedAt: r.ended_at, ...(staff && r.user_login && { via: { login: r.user_login, harness: r.harness ?? "", model: r.reported_model ?? "" } }) },
});


const CHECK_NAMES: Record<string, string> = { fmt: "Format check", clippy: "Clippy", check: "Build check", test: "Tests" };
const outcomeWords = (o: string | null): string => (o === null ? "running" : /^0 findings?$/.test(o) ? "no findings" : /^exit \d+/.test(o) ? `failed (${o})` : o);

export const checkEvent = (c: { id: number; run_id: number | null; step: string; head: string; command: string; crate: string | null; test_name: string | null; task_id: number | null; outcome: string | null; started_at: string }): Ev => ({
  id: `check:${c.id}`, kind: "check", at: c.started_at, head: c.head, actor: step(c.step),
  summary: `${CHECK_NAMES[c.command] ?? humanize(c.command)}${c.crate ? ` on ${c.crate}` : ""}${c.test_name ? ` (${c.test_name})` : ""}: ${outcomeWords(c.outcome)}`,
  ref: { checkId: c.id, head: c.head, ...(c.run_id !== null ? { runId: c.run_id } : {}), ...(c.task_id !== null ? { taskId: c.task_id } : {}) },
});
export const taskEvent = (t: { id: number; job_id: number | null; step: string; head_sha: string; state: string; summary: string | null; queued_at: string }): Ev => ({
  id: `task:${t.id}`, kind: "check", at: t.queued_at, head: t.head_sha, actor: step(t.step),
  summary: `Build task ${t.state}${t.summary ? `: ${clip(t.summary, 100)}` : ""}`, ref: { taskId: t.id, head: t.head_sha, ...(t.job_id !== null ? { jobId: t.job_id } : {}) },
});
export const pushEvent = (p: { id: number; at: string; stage: string; action: string; to_oid: string; before_res: string; after_res: string | null; outcome: string | null }): Ev => ({
  id: `push:${p.id}`, kind: "check", at: p.at, head: p.to_oid, actor: step(p.stage),
  summary: `${GITHUB_ACTIONS[p.action] ?? humanize(p.action)} by AutoCraft: required checks ${p.before_res} → ${p.after_res ?? "pending"}${p.outcome ? `, ${p.outcome}` : ""}`, ref: { head: p.to_oid },
});
export const patchCheckEvent = (p: { id: number; kind: string; subject: string; round: number; verdict: string; model: string; reasons: string; created_at: string }): Ev => ({
  id: `patchcheck:${p.id}`, kind: "check", at: p.created_at, head: null, actor: model(p.model, "model"), summary: `Patch check (${p.kind}, round ${p.round}): ${p.verdict}`,
  ref: {}, detail: { subject: p.subject, reasons: p.reasons },
});


export type OpusRow = { head_oid: string; at: string; model: string | null; mode: string | null; verdict: string | null; sure: number | null; reason: string | null; risks: unknown; fixes: unknown; claims?: unknown };
export const opusEvent = (r: OpusRow, key: string): Ev => ({
  id: `review:${key}`, kind: "review", at: r.at, head: r.head_oid, actor: model(r.model, "opus"),
  summary: `Opus review: ${r.verdict ?? "no verdict"}${arr(r.fixes).length ? ` with ${plural(arr(r.fixes).length, "fix")}` : ""}${r.sure === 0 ? ", not sure" : ""}`, ref: { reviewId: key, head: r.head_oid },
  detail: { mode: r.mode, verdict: r.verdict, sure: r.sure === 1, reason: r.reason, fixes: arr(r.fixes), risks: arr<string>(r.risks), claims: arr(r.claims ?? null) },
});

export const premergeEvent = (r: { head_oid: string; at: string; model: string | null; findings: string | null; error: string | null; searched: string | null }): Ev => {
  const f = arr(r.findings);
  return {
    id: `review:premerge:${r.head_oid}`, kind: "review", at: r.at, head: r.head_oid, actor: model(r.model, "premerge"),
    summary: r.error ? `Pre-merge review failed: ${clip(r.error, 100)}` : `Pre-merge review: ${count(f)}`,
    ref: { reviewId: `premerge:${r.head_oid}`, head: r.head_oid }, detail: { findings: f, searched: r.searched, error: r.error },
  };
};
export const postmergeEvent = (r: { merge_sha: string; at: string; model: string | null; findings: string | null; error: string | null }, staff: boolean): Ev => {
  const f = arr<Record<string, unknown>>(r.findings);
  return {
    id: `review:postmerge:${r.merge_sha}`, kind: "review", at: r.at, head: r.merge_sha, actor: model(r.model, "postmerge"),
    summary: r.error ? `Post-merge review failed: ${clip(r.error, 100)}` : `Post-merge review: ${count(f)}`,
    ref: { reviewId: `postmerge:${r.merge_sha}`, head: r.merge_sha },
    // Which stage missed a finding and why is for staff, as on the item page (postmergeOf).
    detail: { findings: staff ? f : f.map(({ missed_by: _by, missed_why: _why, ...rest }) => rest), error: r.error },
  };
};
export const verifyEvent = (v: { head_sha: string; kind: string; state: string; reason: string; summary: string | null; note: string | null; created_at: string; head_task_id: number | null }): Ev => ({
  id: `verify:${v.head_sha}`, kind: "review", at: v.created_at, head: v.head_sha, actor: step("verify"), summary: `Verification (${v.kind}): ${v.state}`,
  ref: { head: v.head_sha, ...(v.head_task_id !== null ? { taskId: v.head_task_id } : {}) }, detail: { reason: v.reason, summary: v.summary, note: v.note },
});





type FixRow = { rowid: number; head: string; to_head: string | null; state: string; reason: string | null; files: unknown; attempt: number; created_at: string; task_id?: number | null; kind?: string };
export const fixEvent = (f: FixRow, id: string, name: string, label: string): Ev => ({
  id: `${id}:${f.rowid}`, kind: "step", at: f.created_at, head: f.head, actor: step(name), summary: `${label}, try ${f.attempt}: ${f.state}${f.reason ? `, ${clip(f.reason, 100)}` : ""}`,
  ref: { head: f.head, ...(f.to_head ? { toHead: f.to_head } : {}), ...(f.task_id ? { taskId: f.task_id } : {}) }, detail: { to: f.to_head, reason: f.reason, files: arr<string>(f.files) },
});
export const fixupEvent = (f: FixRow): Ev => fixEvent(f, "fixup", "fixup", "Fix-up");
export const ciFixEvent = (f: FixRow): Ev => fixEvent(f, "cifix", "cifix", `CI fix (${f.kind})`);
export const conflictEvent = (f: FixRow): Ev => fixEvent(f, "conflict", "conflict", "Conflict merge");
export const mergeEvent = (m: { rowid: number; head_oid: string; at: string; path: string; method: string | null; outcome: string; reason: string | null }): Ev =>
  ({ id: `merge:${m.rowid}`, kind: "step", at: m.at, head: m.head_oid, actor: step("merge"), summary: `Merge attempt (${m.path}${m.method ? `, ${m.method}` : ""}): ${m.outcome}${m.reason ? `, ${clip(m.reason, 100)}` : ""}`, ref: { head: m.head_oid } });


export const turnEvent = (t: { id: number; kind: string; login: string; at: string; len: number; status: string | null }): Ev => ({
  id: `turn:${t.id}`, kind: "conversation", at: t.at, head: null, actor: t.kind === "opus" ? model("opus", "opus") : t.kind === "system" ? step("system") : person(t.login),
  summary: `Conversation ${t.kind} message, ${t.len} characters${t.status && t.status !== "answered" ? ` (${t.status})` : ""}`, ref: {},
});


/** The audit actions a viewer may see as writes: everyone the GitHub writes, maintainers the dashboard actions that are not operator-only, operators all (null). */
export const writeActions = (staff: boolean, operator: boolean): string[] | null =>
  operator ? null : [...new Set([...(staff ? AUDIT_ACTIONS.filter((a) => !operatorOnly(a)) : []), ...Object.keys(GITHUB_ACTIONS)])];

/** One audit row as a trace event; the same wording and actor rules wherever writes are listed. */
export function writeEvent(a: { rowid: number; at: string; login: string; action: string; details: string | Record<string, unknown> | null }, staff: boolean): Ev {
  const { text, ...d } = obj(a.details);
  const gh = a.action in GITHUB_ACTIONS;
  const head = typeof d.head === "string" ? d.head : null;
  const bad = typeof d.error === "string" ? ` (failed: ${clip(d.error, 80)})` : "";
  const more = gh ? detailOf(a.action, { ...d, text }) : "";
  return {
    id: `audit:${a.rowid}`, kind: "write" as const, at: a.at, head, actor: !staff || (gh && typeof d.state === "string") ? step("AutoCraft") : person(a.login),
    summary: gh ? `${GITHUB_ACTIONS[a.action]}${more ? `: ${more}` : ""}${bad}` : humanize(a.action),
    ref: { auditRowid: a.rowid, ...(head ? { head } : {}) },
    detail: staff ? { action: a.action, by: a.login, ...d, ...(typeof text === "string" ? { textLength: text.length } : {}) } : { action: GITHUB_ACTIONS[a.action] ?? a.action, detail: more },
  };
}




/** Heads are known for pushes, reviews and checks only; a model call, job or decision between two of them belongs to the head current at its time. */
export function carryHeads(events: Ev[]): void {
  const asc = [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
  let current: string | null = null;
  for (const e of asc) {
    if (e.head) current = e.head;
    else if (current && (e.kind === "model-call" || e.kind === "job" || e.kind === "decision" || e.kind === "conversation")) e.head = current;
  }
}

const REVIEW_PROMPTS: [prefix: string, prompt: string][] = [["review:opus", "review.opus"], ["review:premerge:", "premerge.opus"], ["review:postmerge:", "postmerge.opus"]];

/**
 * A review is made by model calls (more than one when its reply took a fix turn or a repeat). Each review gets the calls of its
 * prompt that started after the previous review of the same kind and before it, in `ref.runIds` (and the first in `ref.runId`).
 * Returns the ids of the calls taken, so the timeline lists them once, inside the review.
 */
export function linkReviewCalls(events: Ev[]): Set<number> {
  const taken = new Set<number>();
  const calls = events.filter((e) => e.kind === "model-call" && e.ref.runId !== undefined && e.call?.promptId);
  for (const [prefix, prompt] of REVIEW_PROMPTS) {
    const reviews = events.filter((e) => e.kind === "review" && e.id.startsWith(prefix)).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    reviews.forEach((r, i) => {
      const from = i > 0 ? reviews[i - 1]!.at : "";
      const mine = calls.filter((c) => c.call!.promptId!.startsWith(prompt) && c.at > from && c.at <= r.at).sort((a, b) => (a.at < b.at ? -1 : 1));
      if (mine.length === 0) return;
      const ids = mine.map((c) => c.ref.runId!);
      r.ref = { ...r.ref, runId: ids[0], runIds: ids };
      const costs = mine.map((c) => c.call!.costUsd).filter((v): v is number => v !== null);
      r.costUsd = costs.length ? costs.reduce((a, b) => a + b, 0) : null;
      for (const id of ids) taken.add(id);
    });
  }
  return taken;
}

/** Every source runs whatever the filter, so a filtered event still gets the head its neighbours carry. */
export const VEILED_KINDS: TraceKind[] = ["model-call", "check", "review", "decision", "conversation"];

/** A viewer's copy of a step, job or plan event on a quiet pull request: the kind, time and outcome state stay; free text goes. */
export function veilEvent(e: Ev): Ev {
  if (!["step", "job", "plan"].includes(e.kind)) return e;
  let summary = e.summary;
  const colon = summary.indexOf(": ");
  if (e.kind === "step" && colon >= 0) {
    const comma = summary.indexOf(", ", colon + 2);
    summary = comma >= 0 ? summary.slice(0, comma) : summary;
  } else if (e.id.startsWith("plan:")) summary = summary.replace(/, waiting for .*$/, "");
  else if (colon >= 0) summary = summary.slice(0, colon);
  const detail = e.detail ? { ...e.detail } as Record<string, unknown> : undefined;
  if (detail) for (const k of ["reason", "outcome", "error", "wait", "note"]) if (k in detail) detail[k] = null;
  if (detail && "reasons" in detail) detail.reasons = [];
  return { ...e, summary, ...(detail ? { detail } : {}) };
}


/** The header of a quiet pull request for viewers: the state only, without the planner's reasons and notes or the questions asked about it. */
function veilHeader(h: ItemTraceHeader): ItemTraceHeader {
  return {
    ...h,
    now: { ...h.now, text: h.now.state ?? "Not planned yet", waitsOn: null, reasons: [], note: null },
  };
}

/**
 * What a viewer reads of an event's detail: the fields the item page and timeline give them. Anything not listed (model reasons, fixes,
 * risks, claims, verification and fix-up text, job errors) is staff only, and so is every kind this table does not know.
 */
const VIEWER_FIELDS: [match: (e: Ev) => boolean, fields: string[]][] = [
  [(e) => e.id.startsWith("plan:"), ["from", "to"]],
  [(e) => e.kind === "job", ["step", "state"]],
  [(e) => e.id.startsWith("patchcheck:"), ["subject"]],
  [(e) => e.id.startsWith("review:opus") || e.id.startsWith("review:opus-latest:"), ["mode", "verdict", "sure"]],
  [(e) => e.id.startsWith("review:premerge:"), ["findings", "searched", "error"]],
  [(e) => e.id.startsWith("review:postmerge:"), ["findings", "error"]],
  [(e) => e.kind === "step", ["to"]],
  [(e) => e.kind === "write", ["action", "detail"]],
];
const viewerFields = (e: Ev): Record<string, unknown> => {
  const allowed = VIEWER_FIELDS.find(([match]) => match(e))?.[1] ?? [];
  return Object.fromEntries(Object.entries(e.detail ?? {}).filter(([k]) => allowed.includes(k)));
};

/** A viewer's summary of an event whose wording ends in model or log text: the part before that text. */
export function plainSummary(e: Ev): string {
  if (e.id.startsWith("plan:")) return e.summary.replace(/, waiting for .*$/, "");
  const colon = e.summary.indexOf(": ");
  if (colon < 0) return e.summary;
  // The note of a stage and the outcome of a job carry review, verification and failure text; a job keeps its leading state word.
  if (e.id.startsWith("stage:") || e.summary.startsWith("Question withdrawn")) return e.summary.slice(0, colon);
  if (e.kind === "job") {
    const word = /^[A-Za-z-]+/.exec(e.summary.slice(colon + 2))?.[0];
    return word ? `${e.summary.slice(0, colon)}: ${word}` : e.summary.slice(0, colon);
  }
  if (e.kind === "step") {
    const comma = e.summary.indexOf(", ", colon + 2);
    return comma >= 0 ? e.summary.slice(0, comma) : e.summary;
  }
  if (e.kind === "model-call") return `${e.summary.slice(0, colon)}: ${e.call?.state === "running" ? "running" : e.call?.state === "failed" ? "failed" : "done"}`;
  if (e.id.startsWith("task:") || e.id.startsWith("review:premerge:") || e.id.startsWith("review:postmerge:")) return e.summary.slice(0, colon);
  return e.summary;
}

const strip = ({ detail: _d, ...e }: Ev): TraceEvent => e;


// ---- events from the view's rows -------------------------------------------------------------------------------------------------

const WORKFLOW_WORDS: Record<string, string> = { started: "Started", answered: "Answered", stopped: "Held", resumed: "Resumed", archived: "Earlier question", approved: "Approved", closed: "Closed", backlog: "Moved to the backlog" };
/** The row of an earlier system an archived event stands for (src/db/switch-over.ts): a question, or an action taken for one. */
const legacyOf = (parsed: unknown): string => { const l = (parsed as { legacy?: unknown } | null | undefined)?.legacy; return typeof l === "string" ? l : ""; };
/** A workflow event (an answer, a start, a hold), of kind "decision". An archived one is the person's who answered, a question nobody answered the pipeline's. */
export const workflowEvent = (e: { id: number; login: string; kind: string; parsed?: unknown; line?: string | null; at: string }, r: Pick<Reader, "staff" | "hidden">): Ev => {
  const archived = e.kind === "archived", act = archived && legacyOf(e.parsed).startsWith("action:");
  const line = blankIfHidden(e.line ?? "", r.hidden);
  const answer = archived && !act && e.login !== "pipeline" ? /^(?:.* )?Answer: (.*)\.$/.exec(line)?.[1] : undefined;
  return {
    id: `workflow:${e.id}`, kind: "decision", at: e.at, head: null, actor: act ? step("act") : archived && e.login === "pipeline" ? step("decide") : person(e.login),
    summary: r.staff && line ? clip(line, 140) : answer ? `Answered: ${clip(answer, 100)}` : act ? "Earlier action" : WORKFLOW_WORDS[e.kind] ?? humanize(e.kind), ref: {}, detail: { text: line },
  };
};

/** A mention of the item on Discord: the link, the time and the channel; no message text is stored. */
export const discordEvent = (m: ItemMention): Ev => ({
  id: `discord:${m.msgHash}`, kind: "discord", at: m.at, head: null, actor: person("Discord"),
  summary: m.channel ? `Mentioned on Discord in #${m.channel}` : "Mentioned in a Discord channel", ref: { url: m.url },
});

/** The trace's rows with the Discord mentions the key opens. */
export type TraceRows = ItemTraceRows & { discord?: ItemMention[] };

/** The scope the data views take, from the request context. */
export const traceScope = (c: Ctx) => ({ staff: c.staff, operator: c.operator, hidden: c.hidden });

const least = (a: string | null, b: string | null): string => (a !== null && (b === null || a <= b) ? a : b ?? "");

/** Every source's events of the item, unfiltered and not yet shaped for the reader. An event's id is made from its stored row's key, as the activity feed makes it. */
export function eventsFrom(c: Ctx, r: TraceRows): Ev[] {
  const { own, staff } = c;
  const out: Ev[] = [];
  const it = r.detail.item;
  if (it?.created_at) out.push(openedEvent(it));
  // AutoCraft's own merge step records its entry (mergeEvent); a second GitHub entry would count the same merge twice.
  if (it?.merged_at && !r.merges.some((m) => m.outcome === "merged")) out.push(mergedEvent(it));
  else if (it?.closed_at) out.push(closedEvent(it));
  for (const m of r.detail.comments) {
    if (!m.created_at) continue;
    const body = m.body ?? "";
    out.push(commentEvent({ id: m.id, kind: m.kind, author: m.author, created_at: m.created_at, review_state: m.review_state, commit_oid: m.commit_oid, len: body.length, body: body.slice(0, TRACE_BODY_MAX), cut: body.length > TRACE_BODY_MAX }, own));
  }
  for (const m of r.detail.commits) {
    // Our own commits are shown by their audit rows.
    if (isOwnLogin(own, m.author)) continue;
    out.push({ id: `commit:${m.oid}`, kind: "github", at: least(m.committed_at, m.first_seen_at ?? m.committed_at), head: m.oid, actor: person(m.author), summary: `Pushed commit ${m.oid.slice(0, 7)}`, ref: { head: m.oid } });
  }
  for (const a of r.detail.activity) out.push(activityEvent(a, own));
  for (const s of r.stages) out.push(stageEvent(s));
  for (const p of r.planHistory) out.push(planEventFor(c, { id: p.id, head: p.head, old_state: p.oldState, new_state: p.newState, wait: p.wait, reasons: JSON.stringify(p.reasons), at: p.at }));
  for (const j of r.jobTrail) out.push(jobEvent({ id: j.id, job_id: j.job_id, outcome: j.outcome, at: j.at, step: j.step, state: j.state, error: j.error }));
  for (const x of r.runs) out.push(runEvent({
    id: x.id, step: x.step, prompt_id: x.promptId, model: x.model, provider: x.provider, state: x.state, started_at: x.startedAt, ended_at: x.endedAt, input_tokens: x.tokens.input,
    output_tokens: x.tokens.output, cost_usd: x.costUsd, summary: x.summary, label: null, tools: x.toolCount, job_id: x.jobId, user_login: x.userLogin, harness: x.harness, reported_model: x.reportedModel,
  }, staff));
  for (const k of r.modelChecks) out.push(checkEvent({ id: k.id, run_id: k.runId, step: k.step, head: k.head, command: k.command, crate: k.crate, test_name: k.testName, task_id: k.taskId, outcome: k.outcome, started_at: k.startedAt }));
  for (const t of r.tasks) out.push(taskEvent({ id: t.id, job_id: t.jobId, step: t.step, head_sha: t.headSha, state: t.state, summary: t.summary, queued_at: t.queuedAt }));
  for (const p of r.pushOutcomes) out.push(pushEvent(p));
  for (const p of r.patchChecks) out.push(patchCheckEvent({ id: p.id, kind: p.kind, subject: p.subject, round: p.round, verdict: p.verdict, model: p.model, reasons: p.reasons, created_at: p.createdAt }));
  const rev = r.review;
  const seen = new Set<string>();
  for (const h of rev?.history ?? []) {
    seen.add(`${h.head}|${h.at}`);
    out.push(opusEvent({ head_oid: h.head, at: h.at, model: h.model, mode: h.mode, verdict: h.verdict, sure: h.sure ? 1 : 0, reason: h.reason, risks: h.risks, fixes: h.fixes, claims: h.claims }, `opus:${h.rowid}`));
  }
  // Reviews stored before the history table existed.
  for (const l of rev?.reviews ?? [])
    if (!seen.has(`${l.head}|${l.at}`))
      out.push(opusEvent({ head_oid: l.head, at: l.at, model: l.model, mode: l.mode, verdict: l.verdict, sure: l.sure ? 1 : 0, reason: l.reason, risks: l.risks, fixes: l.fixes, claims: l.claims }, `opus-latest:${l.head}`));
  for (const p of rev?.premerge ?? []) out.push(premergeEvent(p));
  if (rev?.postmerge) out.push(postmergeEvent({ merge_sha: rev.postmerge.merge_sha, at: rev.postmerge.at, model: rev.postmerge.model, findings: rev.postmerge.findings as unknown as string, error: rev.postmerge.error }, staff));
  for (const v of r.verifications) out.push(verifyEvent({ head_sha: v.headSha, kind: v.kind, state: v.state, reason: v.reason, summary: v.summary, note: v.note, created_at: v.createdAt, head_task_id: v.tasks.find((t) => t.role === "head")?.id ?? null }));
  for (const f of r.patches) {
    const row = { rowid: f.id, head: f.head, to_head: f.toHead, state: f.state, reason: f.reason, files: f.files, attempt: f.attempt, created_at: f.createdAt, task_id: f.taskId, kind: f.ciKind ?? undefined };
    out.push(f.kind === "fixup" ? fixupEvent(row) : f.kind === "cifix" ? ciFixEvent(row) : conflictEvent(row));
  }
  for (const m of r.merges) out.push(mergeEvent({ rowid: m.rowid, head_oid: m.head, at: m.at, path: m.path, method: m.method, outcome: m.outcome, reason: m.reason }));
  for (const w of r.workflowEvents) out.push(workflowEvent(w, c));
  for (const t of r.turns) out.push(turnEvent(t));
  for (const m of r.discord ?? []) out.push(discordEvent(m));
  for (const a of r.writes as AuditRow[]) {
    const e = writeEvent(a, staff);
    const branch = typeof a.details?.batch === "string" ? a.details.batch : null;
    const id = branch ? r.batches.get(branch) : undefined;
    out.push(id === undefined ? e : { ...e, ref: { ...e.ref, batchId: id } });
  }
  return out;
}

/** Events the reader may see, with the head their neighbours carry, filtered to `kinds`, oldest first. */
export function shape(c: Ctx, raw: Ev[], kinds: Set<TraceKind> | null): Ev[] {
  const all: Ev[] = [];
  for (const e of raw) {
    if (c.veiled && VEILED_KINDS.includes(e.kind)) continue;
    const at = iso(e.at);
    if (at) all.push({ ...(c.veiled ? veilEvent(e) : e), at, ...(c.staff ? {} : { summary: plainSummary(c.veiled ? veilEvent(e) : e) }) });
  }
  carryHeads(all);
  const taken = !kinds || kinds.has("review") ? linkReviewCalls(all) : new Set<number>();
  return (kinds ? all.filter((e) => kinds.has(e.kind)) : all).filter((e) => !(e.kind === "model-call" && taken.has(e.ref.runId ?? -1))).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
}

export async function loadTraceRows(c: Ctx): Promise<TraceRows & { discord: ItemMention[] }> {
  const rows = await loadItemTrace(c.db, traceScope(c), { repo: c.repo, number: c.n }, writeActions(c.staff, c.operator));
  return { ...rows, discord: await openMentions(c.db, rows.mentions) };
}

export async function gather(c: Ctx, kinds: Set<TraceKind> | null): Promise<Ev[]> {
  return shape(c, eventsFrom(c, await loadTraceRows(c)), kinds);
}

export function headerOf(c: Ctx, r: ItemTraceRows): ItemTraceHeader {
  const { box, hidden } = c;
  const { plan, hold } = r.header;
  const view = obj(plan?.view);
  const acts = (plan?.actions ?? []).filter((a) => a && typeof a.kind === "string" && !a.refused) as { kind: string; head?: unknown }[];
  const assignees = arr(r.detail.item?.assignees).filter((x): x is string => typeof x === "string");
  // The planner's texts as this reader may see them: no item of a hidden repo, and for viewers no note and plain reasons.
  const wait = waitFor(c, plan?.wait ?? null);
  const note = c.staff ? blankIfHidden(plan?.note ?? null, hidden) || null : null;
  const next = typeof view.next === "string" ? blankIfHidden(view.next, hidden) || null : null;
  return {
    now: {
      state: plan?.state ?? null, head: plan?.head ?? null, plannedAt: plan?.plannedAt ?? null,
      text: plan ? (next ?? wait ?? note ?? plan.state) : "Not planned yet", waitsOn: wait, reasons: reasonsFor(c, plan?.reasons ?? []), note,
    },
    next: acts.map((a) => ({ kind: a.kind, head: typeof a.head === "string" ? a.head : null })),
    who: { assignees, autocraftAssigned: box !== "" && assignees.includes(box), holds: hold ? [hold] : [] },
  };
}

/** A fingerprint of what the item's sources hold. Equal fingerprints mean the answer would not change, so `since` is answered without gathering anything. */
export const fingerprint = (c: Ctx, qkey: string, sources: unknown[]): string => {
  const parts: unknown[] = [qkey, c.staff, c.operator, c.hidden, ...sources];
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
};

/** The item a request names, once its repo is visible to the requester: no read of the item starts before that. */
export async function visibleItem(db: Db, req: Req): Promise<{ repo: string; number: number }> {
  const repo = req.params.repo!, number = Number(req.params.n);
  if (!Number.isInteger(number)) throw new HttpError(400, "not an item number");
  await needVisible(db, req, repo);
  return { repo, number };
}

/** What the trace's reads narrow by. The caller reads alongside `context`, which says whether the item exists, and drops the rows when that throws. */
export const contextScope = async (db: Db, req: Req) => ({ staff: canSeeInternals(req), operator: req.user.role === "operator", hidden: await hiddenRepos(db, req) });

export async function context(db: Db, req: Req): Promise<Ctx> {
  // The visibility check decides first: an item of a hidden repo is a 404 for its repo whether or not the mirror has it.
  const { repo, number: n } = await visibleItem(db, req);
  // The rest reads alongside the item, and counts only when the mirror has it.
  const staff = canSeeInternals(req);
  const rest = Promise.all([setting(db, "pipeline_login"), ownLogins(db, repo), staff ? new Set<string>() : loadQuiet(db, [`${repo}#${n}`]), hiddenRepos(db, req)]);
  void rest.catch(() => {});
  const found = await loadShown(db, [{ repo, number: n }]);
  if (!found.has(`${repo}#${n}`)) throw new HttpError(404, `no item ${repo}#${n} in the mirror`);
  const [box, own, quiet, hidden] = await rest;
  return { db, repo, n, ref: `${repo}#${n}`, own, box: box ?? "", staff, veiled: quiet.has(`${repo}#${n}`), operator: req.user.role === "operator", hidden };
}

export async function trace(db: Db, req: Req): Promise<ItemTrace | { unchanged: true; stamp: string }> {
  const q = (k: string) => req.query.get(k) || undefined;
  const limitRaw = q("limit");
  if (limitRaw !== undefined && !/^\d{1,4}$/.test(limitRaw)) throw new HttpError(400, "limit must be a whole number");
  const limit = Math.min(Math.max(Number(limitRaw ?? TRACE_PAGE_DEFAULT), 1), TRACE_PAGE_MAX);
  let kinds: Set<TraceKind> | null = null;
  const kq = q("kinds");
  if (kq) {
    const list = kq.split(",");
    if (list.some((k) => !KINDS.includes(k as TraceKind))) throw new HttpError(400, `kinds are ${KINDS.join(", ")}`);
    kinds = new Set(list as TraceKind[]);
  }
  const only = q("autocraftOnly") === "1" || q("autocraftOnly") === "true";
  const cursor = q("cursor");
  let after: { at: string; id: string } | null = null;
  if (cursor) {
    const i = cursor.indexOf("|");
    const at = i < 1 ? null : iso(cursor.slice(0, i));
    if (!at) throw new HttpError(400, "bad cursor");
    after = { at, id: cursor.slice(i + 1) };
  }
  // The stamp's sources are read with the context, which decides whether they count.
  const ref = await visibleItem(db, req);
  const sources = contextScope(db, req).then((s) => loadItemTraceStamp(db, s, ref));
  void sources.catch(() => {});
  const c = await context(db, req);
  const stamp = fingerprint(c, JSON.stringify([kq ?? "", only, limit]), await sources);
  // `since` applies to the first page; a later page is always read.
  if (!cursor && q("since") === stamp) return { unchanged: true, stamp };
  const rows = await loadTraceRows(c);
  let events = shape(c, eventsFrom(c, rows), kinds);
  if (only) events = events.filter((e) => e.actor.type !== "person");
  const rest = after ? events.filter((e) => e.at > after.at || (e.at === after.at && e.id > after.id)) : events;
  const page = rest.slice(0, limit).map(strip);
  const last = page[page.length - 1];
  const header = headerOf(c, rows);
  return { header: c.veiled ? veilHeader(header) : header, events: page, nextCursor: rest.length > limit && last ? `${last.at}|${last.id}` : null, stamp };
}

/** The fields an event keeps back from the list, for the kinds whose detail has no endpoint of its own (runs and build tasks have theirs). */
export async function traceDetail(db: Db, req: Req): Promise<ItemTraceDetail> {
  const c = await context(db, req);
  const e = (await gather(c, null)).find((x) => x.id === (req.query.get("id") ?? ""));
  if (!e) throw new HttpError(404, "no such event");
  return { id: e.id, kind: e.kind, at: e.at, summary: e.summary, fields: c.staff ? e.detail ?? {} : viewerFields(e) };
}
