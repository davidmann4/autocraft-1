// The item page's story: one oldest-first list of what people, Opus and the harness did to the item. People's answers and messages and
// Opus's reviews and replies are turns; the harness's work (jobs, checks, writes, fix-ups, merges) is lines the page folds into runs.
// Redaction: viewers get lines without prompts, texts, model calls or job errors; a quiet pull request keeps what the trace context already veils.
import type { HistoryCall, TimelineEntry, TimelineTone } from "../../../web/src/api/types.ts";
import type { Preapproval } from "../../../web/src/api/types.ts";
import { GITHUB_ACTIONS } from "../../github/actions.ts";
import { filingOutcome, HELD_STUCK_MS } from "../../conversations/held.ts";
import type { ItemPageFacts } from "../../data/views/item-page.ts";
import { arr, clip, stepTitle, type Ctx, type Ev } from "./trace.ts";
import { implementationLines, implementationRunIds, type ImplementationData } from "./item-implementation.ts";

const short = (s: string | null | undefined): string => (s ?? "").slice(0, 7);
const validRunId = (id: unknown): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0;
const modelCall = (e: Ev): HistoryCall => ({
  label: `${e.call?.step ?? e.summary} (${e.call?.model ?? e.actor.name})`, kind: "model", costUsd: e.call?.costUsd ?? null,
  ...(e.call?.via && { via: e.call.via }), ...(validRunId(e.ref.runId) && { runId: e.ref.runId }),
});
const VERDICT: Record<string, string> = { take: "take", "take-fix": "take with fixes", hold: "not ready", close: "close" };
const VERDICT_TONE: Record<string, TimelineTone> = { take: "ok", "take-fix": "warn", hold: "warn", close: "bad" };
const BAD = /fail|error|refus|reject|broke|too-large/i;
const toneOf = (s: string): TimelineTone => (BAD.test(s) ? "bad" : /merged|pushed|passed|ok\b|approve|done|green/i.test(s) ? "ok" : "neutral");

const base = (id: string, at: string, kind: TimelineEntry["kind"], actor: string, icon: TimelineEntry["icon"], text: string): TimelineEntry => ({
  id, at, kind, actor, icon, text, tone: "neutral", costUsd: null, major: false, jobId: null, reviewId: null, githubId: null, commit: null, preapproval: null, calls: [], body: null, markdown: false, lines: [],
});

/** What a job did, in the page's words; the job's own outcome is internal wording and shows only when it failed. */
const PLAIN: Record<string, string> = {
  fixup: "Fix-up started", cifix: "CI fix started", decide: "Opus prepared the question", "merge-ask": "Opus prepared the merge question", "classify-new": "Classified", "classify-all": "Classified", prioritize: "Priority set", rank: "Queue position updated",
  embed: "Indexed for similar items", dupes: "Checked for duplicates", "dupes-compare": "Compared duplicates", referee: "Label disagreement settled", "labels-apply": "Labels applied", "review-post": "Review posted",
  "review-carry": "Earlier review carried over", "review-batch": "Review prepared", unassign: "Unassigned", "ci-approve": "CI runs approved", verify: "Verification planned", "verify-collect": "Verification result read", "pr-build": "Pull request build",
  checks: "CI read", merge: "Merge queue run", conversation: "Opus replied", act: "Action run", postmerge: "Post-merge review", "postmerge-file": "Follow-up issues filed", premerge: "Pre-merge review",
};

const PLAIN_BY_TITLE = new Map(Object.entries(PLAIN).map(([id, text]) => [stepTitle(id), text]));

/** The page's timeline. `ev` is the item trace; `preapprovals` are the item's rows, oldest first; `impl` the issue's implementation attempt. */
export function timelineOf(c: Ctx, ev: Ev[], preapprovals: Preapproval[], impl: ImplementationData | null, f: ItemPageFacts, prBuildsOn: boolean): TimelineEntry[] {
  const { staff } = c;
  const out: TimelineEntry[] = [];
  // The implementation's model calls show on its own lines (implementationLines), not on its jobs' lines.
  const implRuns = implementationRunIds(impl);
  const ownLine = (e: Ev) => typeof e.ref.runId === "number" && implRuns.has(e.ref.runId);
  const callsOf = (jobId: unknown): HistoryCall[] =>
    !staff ? [] : ev.filter((x) => x.kind === "model-call" && x.ref.jobId === jobId && !ownLine(x)).map(modelCall);
  const callCost = (calls: HistoryCall[]): number | null => (calls.some((x) => x.costUsd !== null) ? calls.reduce((s, x) => s + (x.costUsd ?? 0), 0) : null);
  const fixSteps = ev.filter((e) => e.kind === "step" && /^(fixup|cifix|conflict):/.test(e.id));
  const stepOfJob = new Map<number, string>([...f.trace.jobTrail.map((j): [number, string] => [j.job_id, j.step]), ...f.activeJobs.map((j): [number, string] => [j.id, j.step]), ...f.failedJobs.map((j): [number, string] => [j.id, j.step])]);
  const jobsWithCalls = new Set(ev.filter((e) => e.kind === "job").map((e) => e.ref.jobId));
  const mergeSteps = ev.filter((e) => e.kind === "step" && e.id.startsWith("merge:"));
  // A review that exists all the same has its own line.
  const asApproved = f.landed?.why === null && !f.trace.review?.postmerge;
  const near = (a: string, b: string, ms: number) => Math.abs(Date.parse(a) - Date.parse(b)) <= ms;
  // The model calls named by the reader-filtered review refs, read once.
  const reviewRunIds = ev.flatMap((e) => e.kind === "review" ? (e.ref.runIds ?? (validRunId(e.ref.runId) ? [e.ref.runId] : [])) : []).filter(validRunId);
  const calls = staff ? runRows(f, reviewRunIds) : new Map<number, RunRow>();

  for (const e of ev) {
    const after = e.summary.includes(": ") ? e.summary.slice(e.summary.indexOf(": ") + 2) : e.summary;
    if (e.kind === "github") {
      if (e.id === "gh:merged" && !mergeSteps.length) { const t = base(e.id, e.at, "harness", "GitHub", "merge", e.summary); t.major = true; t.tone = "ok"; out.push(t); }
      continue;
    }
    if (e.kind === "plan" || e.kind === "decision" || e.kind === "conversation") continue;
    if (e.kind === "model-call") {
      if (jobsWithCalls.has(e.ref.jobId) || ownLine(e)) continue;
      const title = e.call?.step ?? "Model call";
      const t = base(e.id, e.at, "harness", "AutoCraft", "job", PLAIN_BY_TITLE.get(title) ?? `${title}: ${e.summary.replace(/^[^:]*:\s*/, "")}`);
      t.costUsd = e.call?.costUsd ?? null;
      if (staff && validRunId(e.ref.runId)) t.calls = [modelCall(e)];
      out.push(t);
    } else if (e.kind === "job") {
      // A fix-up's job repeats its step line; its model calls move to that line.
      if (fixSteps.some((f) => near(f.at, e.at, 180_000)) && /fix|conflict/i.test(e.actor.name)) continue;
      // The review and verification lines say what these jobs did.
      const stepId = typeof e.ref.jobId === "number" ? stepOfJob.get(e.ref.jobId) : undefined;
      // By step as well as by text: a viewer's summary keeps only the outcome's first word.
      if (/^(Opus review:|verify-)/.test(after) || (stepId !== undefined && /^(opus-review|verify(-collect)?)$/.test(stepId))) continue;
      const calls = callsOf(e.ref.jobId);
      if (stepId === "premerge" || stepId === "postmerge") continue;
      const plain = stepId ? PLAIN[stepId] : undefined;
      const failed = /^(failed|refused|error)/i.test(after);
      const t = base(e.id, e.at, "harness", "AutoCraft", "job", `${plain ?? e.actor.name}${failed ? ` failed${staff ? `: ${clip(after.replace(/^(failed|refused|error):?\s*/i, ""), 140)}` : ""}` : plain ? "" : `: ${staff ? after : after.split(":")[0]!}`}`);
      t.calls = calls; t.costUsd = callCost(calls); t.jobId = typeof e.ref.jobId === "number" ? e.ref.jobId : null; t.tone = toneOf(after);
      t.major = /^failed/.test(after);
      out.push(t);
    } else if (e.kind === "check") {
      const t = base(e.id, e.at, "harness", "AutoCraft", "check", e.summary);
      t.tone = toneOf(after);
      out.push(t);
    } else if (e.kind === "review") {
      const id = e.id.replace(/^review:/, "");
      const reviewCalls = staff ? runCalls(calls, e.ref.runIds ?? (validRunId(e.ref.runId) ? [e.ref.runId] : [])) : [];
      if (id.startsWith("opus")) {
        const verdict = String(e.detail?.verdict ?? "hold");
        const sure = e.detail?.sure === true;
        const t = base(e.id, e.at, "opus", "Opus", "review", `review: ${VERDICT[verdict] ?? verdict}${sure ? "" : ", unsure"}`);
        t.tone = VERDICT_TONE[verdict] ?? "neutral"; t.costUsd = e.costUsd ?? null; t.major = true; t.reviewId = id;
        t.calls = reviewCalls;
        out.push(t);
      } else {
        const t = base(e.id, e.at, "harness", "AutoCraft", id.startsWith("verify") ? "check" : "review", id.startsWith("verify") ? e.summary.replace(/^Verification \((.*)\): \1$/, "Verification: $1") : e.summary);
        t.tone = toneOf(e.summary); t.major = true; t.costUsd = e.costUsd ?? null;
        t.calls = reviewCalls;
        if (staff && e.detail) t.lines = detailLines(e.detail);
        out.push(t);
      }
    } else if (e.kind === "write") {
      const action = String(e.detail?.action ?? "");
      const push = /-push$/.test(action) || /^Pushed/.test(e.summary);
      const t = base(e.id, e.at, "harness", e.actor.type === "person" ? e.actor.name : "AutoCraft", push ? "push" : "github", e.summary);
      t.githubId = e.id; t.tone = toneOf(e.summary); t.major = push || /close/.test(action);
      if (action === "merge" || (staff && action && !(action in GITHUB_ACTIONS))) continue;
      out.push(t);
    } else if (e.kind === "step") {
      const f = /^(fixup|cifix|conflict):/.exec(e.id) ? /^(.*?), try (\d+): ([\w-]+)(?:, (.*))?$/.exec(e.summary) : null;
      if (f) {
        const [, label, tryN, state] = f;
        const reason = typeof e.detail?.reason === "string" ? e.detail.reason : null;
        const to = typeof e.detail?.to === "string" ? e.detail.to : null;
        const job = ev.find((x) => x.kind === "job" && near(x.at, e.at, 180_000) && /fix|conflict/i.test(x.actor.name));
        const calls = job ? callsOf(job.ref.jobId) : [];
        const text = state === "pushed" && to ? `${label} pushed ${short(to)}` : BAD.test(state) ? `${label} ${state}${reason && staff ? `: ${clip(reason, 120)}` : ""}` : `${label}, try ${tryN}: ${state}${reason && staff ? `, ${clip(reason, 120)}` : ""}`;
        const t = base(e.id, e.at, "harness", "AutoCraft", "fixup", text);
        t.tone = toneOf(state); t.major = true; t.calls = calls; t.costUsd = callCost(calls); t.commit = state === "pushed" && to ? short(to) : null; t.jobId = job && typeof job.ref.jobId === "number" ? job.ref.jobId : null;
        if (staff) t.lines = [...(reason && reason.length > 120 ? [reason] : []), ...arr<string>(JSON.stringify(e.detail?.files ?? [])).map((x) => `File: ${x}`)];
        out.push(t);
      } else if (e.id.startsWith("merge:")) {
        const m = /: (\w+)(?:, (.*))?$/.exec(e.summary);
        const merged = m?.[1] === "merged";
        const t = base(e.id, e.at, "harness", "AutoCraft", "merge", merged ? (asApproved ? "Merged as approved, no post-merge review" : "Merged") : `Merge attempt: ${m?.[1] ?? "no result"}${m?.[2] && staff ? `, ${m[2]}` : ""}`);
        t.major = true; t.tone = merged ? "ok" : toneOf(m?.[1] ?? ""); t.githubId = e.id;
        out.push(t);
      } else {
        const t = base(e.id, e.at, "harness", "AutoCraft", "job", `${e.actor.name}: ${after}`);
        t.tone = toneOf(after);
        // The job of the same name and time is the same work.
        if (!ev.some((x) => x.kind === "job" && x.actor.name === e.actor.name && near(x.at, e.at, 30_000))) out.push(t);
      }
    }
  }

  // Our build failed where upstream CI passed: a note on the item (from pr_builds, not a stage row, so it never becomes the latest stage).
  const b = f.prBuild;
  if (b && b.disagree && b.finishedAt && prBuildsOn) {
    const t = base(`pr-build:${b.headSha}`, b.finishedAt, "harness", "AutoCraft", "check", `Our build failed at ${short(b.headSha)} where CI passed${staff && b.summary ? `: ${clip(b.summary, 140)}` : ""}`);
    t.tone = "bad";
    out.push(t);
  }
  // Screenshot runs (staff only, as the images are): planned when the run was queued, then its outcome. From screenshot_runs, not stage rows.
  if (staff && !c.veiled) {
    for (const r of f.screenshots) {
      if (r.state === "skipped" || r.state === "stale") continue;
      const id = `screenshots:${r.headSha}`;
      if (r.plan !== null) {
        const planned = base(`${id}:planned`, r.createdAt, "harness", "AutoCraft", "check", `Screenshots planned at ${short(r.headSha)}`);
        if (r.reason && r.state !== "error") planned.body = clip(r.reason, 200);
        out.push(planned);
      }
      if (!r.finishedAt || r.state === "planned" || r.state === "running") continue;
      const done = base(`${id}:done`, r.finishedAt, "harness", "AutoCraft", "check", r.state === "error" ? "Screenshots failed" : r.held ? "Screenshot regression: held" : "Screenshots compared");
      done.tone = r.state === "error" ? "warn" : r.held ? "bad" : "neutral"; done.major = r.held;
      done.body = clip(String((r.state === "error" ? r.reason : r.comparison) ?? ""), 300) || null;
      out.push(done);
    }
  }
  // People answer and post: one line each.
  for (const w of f.trace.workflowEvents.filter((e) => e.kind === "answered")) {
    const t = base(`workflow:${w.id}:answered`, w.at, "person", w.login, "person", staff && w.line ? `chose: ${w.line}` : "answered");
    t.major = true;
    out.push(t);
  }
  if (staff) {
    // Opus's messages that answer a person are conversation; the others (a refreshed summary of the question) are the harness's work.
    const turns = f.thread?.turns ?? [];
    turns.forEach((t, i) => {
      // System lines repeat what the press, pre-approval and fix-up lines say.
      if (t.kind === "system") return;
      const opus = t.kind === "opus";
      const reply = opus && turns[i - 1] !== undefined && !["opus", "system"].includes(turns[i - 1]!.kind);
      const e = base(`turn:${t.id}`, t.at, opus && reply ? "opus" : opus ? "harness" : "person", opus ? "Opus" : t.login, "chat", opus && !reply ? "Opus refreshed its summary" : clip(t.body, 110));
      e.major = !(opus && !reply); e.body = t.body; e.markdown = opus;
      if (t.status === "failed") { e.tone = "bad"; e.major = true; e.lines = [t.error ?? "Opus gave no usable reply."]; }
      out.push(e);
    });
  }

  // Pre-approvals: the person's press, and the outcome the fix-up line does not already say.
  preapprovals.forEach((p, i) => {
    const prev = preapprovals[i - 1];
    const again = prev?.state === "failed" && prev.instructions === p.instructions;
    const t = base(`preapproval:${p.id}`, p.at, "person", p.by, "person", again ? "pressed Try again" : "pre-approved: fix-up, then merge");
    t.major = true; t.body = staff ? p.instructions : null;
    out.push(t);
    const info = { id: p.id, state: p.state, latest: i === preapprovals.length - 1 };
    const fix = [...out].reverse().find((x) => x.icon === "fixup" && x.at >= p.at && near(x.at, p.updatedAt, 600_000));
    if (p.state === "failed" && fix) fix.preapproval = info;
    else if (["asked", "cancelled", "failed"].includes(p.state)) {
      const o = base(`preapproval:${p.id}:end`, p.updatedAt, "harness", "AutoCraft", "fixup", `Pre-approved merge ${p.state}${p.reason && staff ? `: ${clip(p.reason, 120)}` : ""}`);
      o.major = true; o.tone = p.state === "failed" ? "bad" : "warn"; o.preapproval = info; out.push(o);
    } else if (["fixup", "review", "ci", "queued"].includes(p.state)) t.preapproval = info;
  });

  // Issues a card held until the merge: the press, and what became of it. A filed one is the "Opened issue" write line.
  for (const h of f.held) {
    const t = base(`held:${h.id}`, h.at, "person", h.by, "person", `After the merge: open an issue in ${h.issue_repo}`);
    t.major = true;
    if (staff && !c.veiled) { t.body = h.title; if (h.state === "held" && h.reason) t.lines = [`Waiting: ${h.reason}`]; }
    out.push(t);
    // A create that was begun and that the Act step cannot settle from its audit row stays unknown.
    const now = Date.now();
    const stuck = h.state === "filing" && Date.parse(h.updated_at) < now - HELD_STUCK_MS && filingOutcome({ ...h, filingAudit: f.heldAudits.get(h.id) ?? null }, now) === null;
    if (h.state !== "dropped" && h.state !== "failed" && !stuck) continue;
    const end = base(`held:${h.id}:end`, h.updated_at, "harness", "AutoCraft", "github",
      h.state === "dropped" ? `Held issue dropped: ${h.reason ?? "no reason recorded"}` : stuck ? "Held issue: the create's outcome is unknown, check GitHub" : `Held issue not opened${staff && h.reason ? `: ${clip(h.reason, 120)}` : ""}`);
    end.major = true; end.tone = h.state === "dropped" ? "warn" : "bad";
    out.push(end);
  }

  out.push(...implementationLines(c, impl, base));

  out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
  return out;
}

type RunRow = { id: number; step: string; model: string; cost_usd: number | null; user_login: string | null; harness: string | null; reported_model: string | null };
/** The item's runs among `ids`, by id. */
function runRows(f: ItemPageFacts, ids: number[]): Map<number, RunRow> {
  const want = new Set(ids);
  return new Map(f.trace.runs.filter((r) => want.has(r.id)).map((r) => [r.id, { id: r.id, step: r.step, model: r.model, cost_usd: r.costUsd, user_login: r.userLogin, harness: r.harness, reported_model: r.reportedModel }]));
}

/** The calls of the runs `ids` that exist, in id order. */
function runCalls(rows: Map<number, RunRow>, ids: number[]): HistoryCall[] {
  return [...new Set(ids.filter(validRunId))].filter((id) => rows.has(id)).sort((a, b) => a - b).map((id) => rows.get(id)!)
    .map((r) => ({ label: `${stepTitle(r.step)} (${r.model})`, kind: "model" as const, runId: r.id, costUsd: r.cost_usd, ...(r.user_login && { via: { login: r.user_login, harness: r.harness ?? "", model: r.reported_model ?? "" } }) }));
}

function detailLines(d: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ["reason", "summary", "note", "error"]) if (typeof d[k] === "string" && d[k]) out.push(d[k] as string);
  for (const f of Array.isArray(d.findings) ? d.findings : []) {
    const x = f as { severity?: string; title?: string };
    if (x?.title) out.push(`${x.severity ? `${x.severity}: ` : ""}${x.title}`);
  }
  return out;
}
