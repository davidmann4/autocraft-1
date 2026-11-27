// Health problems and the Live board on fake data.
import type { Api } from "../client";
import type { Health, ItemRef, ItemShown, LiveBoard, LiveEstimate, LiveWorker, LiveWorkerCall } from "../types";
import { NOW } from "./fixtures";
import { ackedDeadlines, mockSwitch } from "./pipelineMock";
import { nowMs } from "../../lib/format";

const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const HEALTH: Health = {
  pipeline: { enabled: true, by: "operator", at: at(60 * 30) },
  problems: [
    { id: "user-token:own", area: "account", tone: "bad", text: "AutoCraft can no longer act as you on GitHub. Authorize again", to: "/auth/authorize-app", fullPage: true, since: at(5 * 3600) },
    { id: "user-tokens", area: "account", tone: "warn", text: "AutoCraft can no longer act on GitHub as operator until they authorize it again", to: "/admin/github-app", since: at(5 * 3600) },
    { id: "worker:sandbox", area: "workers", tone: "bad", text: "Build worker Sandbox has not reported for 4 h", to: "/envs", since: at(4 * 3600) },
    { id: "build-queue", area: "workers", tone: "bad", text: "3 build tasks have waited over 10 min for a worker", to: "/envs", since: at(1500) },
    { id: "sync-repo:stencilcraft", area: "sync", tone: "warn", text: "storytold/stencilcraft no longer resolves on GitHub (moved, renamed or deleted)", to: "/repos", since: at(3 * 3600) },
    { id: "main-ci:designcraft", area: "main-ci", tone: "bad", text: "Main is red in designcraft: Tests, Clippy", to: "/main-ci", since: at(95) },
    { id: "jobs", area: "jobs", tone: "warn", text: "2 jobs failed in the last hour: Review pull requests", to: "/pipeline", since: null },
    { id: "liveness", area: "liveness", tone: "bad", text: "4 open items are stuck: nothing is due and nobody is asked; 2 more unchanged for days", to: "/stuck", since: at(30 * 3600) },
    { id: "deadline:fixup", area: "deadline", tone: "warn", text: "Fix up pull requests was stopped (job 641: stopped: ran past 120 min)", to: "/pipeline/641", since: at(40), ackStep: "fixup" },
  ],
};

/** The header problems now: the static ones, minus acknowledged deadline stops, plus the Draining warning. */
const healthNow = (): Health => ({
  pipeline: { ...HEALTH.pipeline, enabled: !mockSwitch.draining },
  problems: [
    ...(mockSwitch.draining ? [{ id: "pipeline", area: "pipeline" as const, tone: "warn" as const, text: "Pipeline is draining, switched to drain by operator", to: "/pipeline", since: at(12) }] : []),
    ...HEALTH.problems.filter((p) => !(p.ackStep && ackedDeadlines.has(p.ackStep))),
  ],
});

export function createHealthMock(role: () => string = () => "operator"): Pick<Api, "health" | "live"> {
  return {
    health: () => new Promise((r) => setTimeout(() => r(structuredClone(healthNow())), 60)),
    live: () => new Promise((r) => setTimeout(() => r(liveBoard(nowMs(), role())), 60)),
  };
}

/** The Live board's mock: a few jobs with calls and build steps placed around `now`, one queued, two ended lately. */
function liveBoard(now: number, role: string): LiveBoard {
  const t = (min: number) => new Date(now - min * 60_000).toISOString();
  const est = (median: number, p90: number, samples = 24) => ({ median: median * 60_000, p90: p90 * 60_000, samples });
  const it = (repo: string, number: number, title: string, kind: "pr" | "issue" = "pr") => ({ repo, number, kind, state: "open" as const, title });
  return {
    lanes: [
      { key: "job:1", title: "Review pull requests", state: "running", start: t(14), end: null, line: "Reviewing photocraft#9981 (2 of 3)", item: it("photocraft", 9981, "Fix crop handles on rotated layers"), itemCount: 3, repo: "photocraft", detail: "/pipeline/1", estimate: est(18, 31),
        ops: [
          { kind: "model", label: "claude-opus", detail: "Opus review on main", start: t(14), end: t(9), estimate: null },
          { kind: "model", label: "claude-opus", detail: "Opus review on main", start: t(8.5), end: t(3), estimate: null },
          { kind: "model", label: "claude-opus", detail: "Opus review on main", start: t(2.5), end: null, estimate: est(5, 9) },
        ] },
      { key: "job:2", title: "Verify pull requests", state: "running", start: t(11), end: null, line: "Running the tests of wordcraft#2231", item: it("wordcraft", 2231, "Keep the hyperlink run when exporting the last paragraph"), itemCount: 1, repo: "wordcraft", detail: "/pipeline/2", estimate: est(16, 24),
        ops: [
          { kind: "setup", label: "npm ci", detail: "Verify pull requests", start: t(11), end: t(8.8), estimate: null },
          { kind: "build", label: "build", detail: "Verify pull requests", start: t(8.8), end: t(4.1), estimate: null },
          { kind: "tests", label: "test", detail: "Verify pull requests", start: t(4.1), end: null, estimate: est(6, 9) },
        ] },
      { key: "job:3", title: "Fix-up pull requests", state: "running", start: t(26), end: null, line: "Second round on vectorcraft#1388", item: it("vectorcraft", 1388, "Snap guides ignore locked layers"), itemCount: 1, repo: "vectorcraft", detail: "/pipeline/3", estimate: est(19, 25),
        ops: [
          { kind: "model", label: "claude-sonnet", detail: "Fix-up on main", start: t(26), end: t(17), estimate: null },
          { kind: "lint", label: "lint", detail: "Fix-up check", start: t(17), end: t(15), estimate: null, failed: true },
          { kind: "model", label: "claude-sonnet", detail: "Fix-up on main", start: t(15), end: null, estimate: est(8, 11) },
        ] },
      { key: "task:4", title: "Build task, Build pull requests", state: "running", start: t(3), end: null, line: null, item: it("filmcraft", 3149, "Panel resize handle flickers"), itemCount: 1, repo: "filmcraft", detail: "/envs/4", estimate: null,
        ops: [{ kind: "build", label: "cargo build", detail: "Build pull requests", start: t(3), end: null, estimate: null }] },
      { key: "batch:14", title: "Integration batch", state: "running", start: t(22), end: null, line: "Checking the combined tree", item: it("pdfcraft", 877, "Export fails on pages with spot colors"), itemCount: 2, repo: "pdfcraft", detail: "/batches/14", estimate: null,
        ops: [
          { kind: "setup", label: "cargo fetch", detail: "Check integration batch", start: t(21), end: t(19), estimate: null },
          { kind: "tests", label: "cargo test", detail: "Check integration batch", start: t(19), end: null, estimate: est(24, 30) },
        ] },
      { key: "job:5", title: "Classify new items", state: "queued", start: t(1), end: null, line: null, item: it("gridcraft", 977, "Range spill: keep neighbouring cells when a formula grows", "issue"), itemCount: 4, repo: "gridcraft", detail: "/pipeline/5", estimate: null, ops: [] },
      { key: "job:6", title: "Read GitHub answers", state: "done", start: t(9), end: t(7), line: "Read 1 answer", item: it("designcraft", 1484, "Add Hungarian spellchecking and nonstandard hyphenation"), itemCount: 1, repo: "designcraft", detail: "/pipeline/6", estimate: null,
        ops: [{ kind: "model", label: "claude-haiku", detail: "Answer on main", start: t(9), end: t(7.5), estimate: null }] },
      { key: "job:7", title: "Merge pull requests", state: "failed", start: t(6), end: t(5), line: "Refused: required check has not finished", item: it("filmcraft", 1161, "Color grading: keep state after copy and paste"), itemCount: 1, repo: "filmcraft", detail: "/pipeline/7", estimate: null, ops: [] },
    ],
    // Workers for staff only, as the server sends them.
    ...((role === "operator" || role === "maintainer") && { workers: workers(t, est, it) }),
  };
}

/** The worker view's mock: three people's shared Task Runners, the private row and Jev, with the last hour's calls. */
function workers(
  t: (min: number) => string,
  est: (median: number, p90: number, samples?: number) => LiveEstimate,
  it: (repo: string, number: number, title: string, kind?: "pr" | "issue") => ItemRef & ItemShown,
): LiveWorker[] {
  let id = 900;
  const STEP: Record<string, string> = { "Review pull requests": "opus-review", "Fix issues": "fixissue", "Fix-up pull requests": "fixup", "Read GitHub answers": "commands", "Classify new items": "classify-new", "Find duplicates": "dupes", "Scan for security problems": "security-scan" };
  const call = (title: string, model: string, item: ItemRef & ItemShown | null, start: number, end: number | null, more: Partial<LiveWorkerCall> = {}): LiveWorkerCall =>
    ({ id: id++, step: STEP[title] ?? "other", title, model, item, itemCount: 1, start: t(start), end: end === null ? null : t(end), tokens: end === null ? null : Math.round((start - end) * 41_000), estimate: end === null ? est(6, 11) : null, ...more });
  const crop = it("photocraft", 9981, "Fix crop handles on rotated layers");
  const link = it("wordcraft", 2231, "Keep the hyperlink run when exporting the last paragraph");
  const snap = it("vectorcraft", 1388, "Snap guides ignore locked layers");
  const spill = it("gridcraft", 977, "Range spill: keep neighbouring cells when a formula grows", "issue");
  const grade = it("filmcraft", 1161, "Color grading: keep state after copy and paste");
  const spell = it("designcraft", 1484, "Add Hungarian spellchecking and nonstandard hyphenation");
  return [
    { key: "runner:11", kind: "runner", name: "Studio", login: "mira-k", harness: "claude", status: "online", note: null, busy: 2, slots: 2, models: ["claude-opus-4", "claude-sonnet-4"], calls: [
      call("Review pull requests", "claude-opus", crop, 52, 41), call("Fix issues", "claude-opus", spill, 40, 19), call("Review pull requests", "claude-opus", link, 18, 10),
      call("Review pull requests", "claude-opus", crop, 8.5, null), call("Fix-up pull requests", "claude-sonnet", snap, 4, null),
    ] },
    { key: "runner:12", kind: "runner", name: "Task Runner", login: "jonas-p", harness: "codex", status: "online", note: null, busy: 1, slots: 3, models: ["gpt-5", "gpt-5-mini"], calls: [
      call("Fix issues", "gpt-5", grade, 47, 22), call("Read GitHub answers", "gpt-5-mini", spell, 21, 18.5), call("Fix issues", "gpt-5", grade, 14, null, { estimate: est(20, 31) }),
    ] },
    { key: "runner:13", kind: "runner", name: "Laptop", login: "tsela", harness: "claude", status: "held", note: "5-hour use at the reserve the user keeps (80 %)", busy: 0, slots: 1, models: ["claude-sonnet-4"], calls: [
      call("Review pull requests", "claude-sonnet", snap, 58, 45), call("Review pull requests", "claude-sonnet", link, 44, 33, { failed: true }),
    ] },
    { key: "private", kind: "private", name: "Private Task Runner", login: null, harness: null, status: "online", note: null, busy: 1, slots: null, models: [], calls: [
      call("Find duplicates", "claude-haiku", spell, 50, 48), call("Scan for security problems", "claude-opus", link, 37, 26), call("Review pull requests", "claude-sonnet", grade, 7, null),
    ] },
    { key: "jev", kind: "jev", name: "Jev", login: null, harness: null, status: "online", note: null, busy: 0, slots: null, models: [], calls: [
      call("Classify new items", "Jev", spill, 25, 24.2, { itemCount: 12 }), call("Classify new items", "Jev", spell, 6, 5.4, { itemCount: 9 }),
    ] },
  ];
}
