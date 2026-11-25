import type { Api } from "../client";
import type { InferenceSettings, McpToken, ModelQueue, ModelQueueCall, MySettings, PendingRunnerLogin, RunnerInfo, User } from "../types";
import { NOW } from "./fixtures";

const DAY = 86_400_000;
const MIN = 60_000;

/** The Connect page and the model call queue, in memory; the server's rules (five tokens per kind, own tokens and runners only, pick limits) apply. */
/** The task choices as the server lists them (src/remote/my-tasks.ts TASK_CHOICES). */
const TASKS = [
  { id: "dupes", title: "Duplicates", about: "Finds items that describe the same bug or request as another open item, or one closed in the last year, and compares each group.", models: ["opus", "sonnet", "haiku"] },
  { id: "classify", title: "Classify", about: "Gives each open item one type label and two flags (security, needs decision).", models: ["opus", "sonnet", "haiku"] },
  { id: "priority", title: "Priority", about: "Gives each open item a level from P0 to P4, then orders the candidates of later stages by a work rank.", models: ["haiku"] },
  { id: "decide", title: "Decide", about: "Asks an operator for scope calls, prepares every open decision with a summary, a pick and drafted answers, and answers questions about an item in its conversation.", models: ["opus", "haiku"] },
  { id: "review", title: "Review", about: "Opus reviews every wanted PR at its current head, reading the repo, and gives a verdict with the complete fix list.", models: ["opus"] },
  { id: "fix", title: "Fix", about: "Writes a patch for a bugfix issue where the fix is clear, tests it in the sandbox and opens a PR.", models: ["opus", "sonnet", "haiku"] },
  { id: "fixup", title: "Fix-up", about: "For a take-with-fixes review, applies the listed small fixes to the contributor's branch, or posts them as a comment when the branch cannot be pushed to.", models: ["opus", "sonnet", "haiku"] },
  { id: "verify", title: "Verify", about: "Records upstream CI as the verification of taken PRs in repos that have it.", models: ["opus", "sonnet", "haiku"] },
  { id: "merge", title: "Merge queue", about: "Merges PRs that pass the rules in integration batches (up to 50 PRs, checked by upstream CI on the batch PR) through safe-merge, and asks for a Merge? decision on PRs outside the rules. It also covers the Opus review of a PR's head commit before the PR goes into a batch or a pre-approved merge is handed to the queue.", models: ["opus"] },
  { id: "postmerge", title: "Post-merge review", about: "Opus reviews each PR the pipeline merged a second time, reading what landed with the pipeline's own commits and reviews of the PR, and lists defects and minor findings.", models: ["opus"] },
  { id: "other", title: "Other", about: "Calls of steps outside the stages above: the security scan's checks and private fixes, Discord mentions, searches and issue drafts, and any call whose step is not known.", models: ["opus", "haiku"] },
];

export function createMcpMock(me: User, changed: () => void): Pick<Api, "mcp" | "inference" | "runners" | "modelQueue"> & { meSettings: Api["me"]["settings"] } {
  let inference: InferenceSettings = { mode: me.inference, models: { top: ["opus", "astra"], mid: ["sonnet"], small: ["haiku"] }, minEffort: { top: "high" } };
  let settings: MySettings = { reserve: { fiveHour: 20, weekly: 10 }, maxCalls: null, interactiveSlots: 1, manualOnly: false, tasks: TASKS.map((t) => t.id), taskChoices: TASKS, taskItems: "all", runnerPrivate: false, uiV2: false, repos: ["designcraft", "photocraft", "textcraft"], repoChoices: ["designcraft", "fontcraft", "gridcraft", "iconcraft", "pdfcraft", "photocraft", "Sheetcraft", "wordcraft"] };
  const at = (ms: number) => new Date(NOW + ms).toISOString();
  const wait = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 60));

  let runners: RunnerInfo[] = [
    { tokenId: 2, label: "laptop", slots: 5, busy: 2, lastError: null, readiness: "ready", until: null, reason: null, fresh: true, lastSeen: at(-40_000), harness: "claude", models: { top: "opus", mid: "sonnet", small: "haiku" }, reserve: { fiveHour: 20, weekly: 10 },
      usage: { fiveHour: { usedPercent: 42, resetsAt: at(3 * 3600_000) }, weekly: { usedPercent: 18, resetsAt: at(4 * DAY) }, at: at(-40_000) },
      machine: { hostname: "kestrel", platform: "linux", arch: "x64" }, helperVersion: "1.3.0", createdAt: at(-30 * DAY), expiresAt: at(90 * DAY), agent: true, answer: false },
    { tokenId: 7, label: "studio", slots: 2, busy: 0, lastError: null, readiness: "login-refresh", until: at(3 * MIN), reason: "no call fits before the Claude login is refreshed: the Task Runner has claude refresh it 4 minutes before it ends", fresh: true, lastSeen: at(-25_000), harness: "claude", models: { top: "opus", mid: "sonnet", small: "haiku" }, reserve: { fiveHour: 20, weekly: 10 },
      usage: { fiveHour: { usedPercent: 4, resetsAt: at(4.5 * 3600_000) }, weekly: { usedPercent: 9, resetsAt: at(5 * DAY) }, at: at(-25_000) },
      machine: { hostname: "studio.local", platform: "darwin", arch: "arm64" }, helperVersion: "1.3.0", createdAt: at(-2 * 3600_000), expiresAt: at(90 * DAY), agent: true, answer: true },
    { tokenId: 3, label: "workstation", slots: 2, busy: 0, lastError: { text: "/api/remote/heartbeat: HTTP 502 bad gateway", at: at(-9 * MIN) }, readiness: "quota-held", until: at(95 * MIN), reason: "5-hour window 83% used (reserve 20% free)", fresh: true, lastSeen: at(-4 * MIN), harness: "codex", models: { top: "astra", mid: "astra-mini", small: "astra-mini" }, reserve: { fiveHour: 20, weekly: 10 },
      usage: { fiveHour: { usedPercent: 83, resetsAt: at(95 * MIN) }, weekly: { usedPercent: 61, resetsAt: at(2 * DAY) }, at: at(-4 * MIN) },
      machine: { hostname: "ws-0412", platform: "linux", arch: "x64" }, helperVersion: "1.3.0", createdAt: at(-12 * DAY), expiresAt: at(89 * DAY), agent: false, answer: false },
    { tokenId: 4, label: "mini", slots: 1, busy: 0, lastError: { text: "Review of designcraft#412: the harness exited with code 1", at: at(-26 * MIN) }, readiness: "cooled-off", until: at(5 * 3600_000), reason: "its leases were lost 3 times within 2 hours (no heartbeat, or past the call's time limit)", fresh: true, lastSeen: at(-90_000), harness: "claude", models: { top: "opus", mid: "sonnet", small: "haiku" }, reserve: { fiveHour: 20, weekly: 10 },
      usage: { fiveHour: { usedPercent: 12, resetsAt: at(4 * 3600_000) }, weekly: { usedPercent: 30, resetsAt: at(4 * DAY) }, at: at(-90_000) },
      machine: null, helperVersion: "1.2.0", createdAt: at(-60 * DAY), expiresAt: at(80 * DAY), agent: false, answer: false },
  ];
  // `?states=1` adds a runner that never reported in and one that stopped; left out by default, so the five-runner limit leaves room to approve a login.
  if (new URLSearchParams(location.search).get("states") === "1") runners.push(
    // Logged in but never reported in: its row says to start it.
    { tokenId: 8, label: "wsl", slots: null, busy: null, lastError: null, readiness: null, until: null, reason: null, fresh: false, lastSeen: null, harness: null, models: {}, reserve: null, usage: null,
      machine: { hostname: "desktop", platform: "linux", arch: "x64" }, helperVersion: "1.3.4", createdAt: at(-20 * MIN), expiresAt: at(90 * DAY), agent: true, answer: false },
    // Reported in once, then stopped.
    { tokenId: 9, label: "old-box", slots: 1, busy: 0, lastError: null, readiness: "ready", until: null, reason: null, fresh: false, lastSeen: at(-3 * DAY), harness: "claude", models: { top: "opus", mid: "sonnet", small: "haiku" }, reserve: { fiveHour: 20, weekly: 10 }, usage: null,
      machine: { hostname: "old-box", platform: "linux", arch: "x64" }, helperVersion: "1.3.3", createdAt: at(-40 * DAY), expiresAt: at(50 * DAY), agent: true, answer: false }
  );
  // `?runners=N` keeps the first N, for screenshots of a user with fewer Task Runners.
  const keep = new URLSearchParams(location.search).get("runners");
  if (keep !== null && /^\d+$/.test(keep)) runners = runners.slice(0, Number(keep));
  // `?runner=BCDF-GHJK` comes from this browser's address, `?runner=QRST-VWXZ` from another one.
  const pending = new Map<string, PendingRunnerLogin>([
    ["BCDFGHJK", { label: "desk", machine: { hostname: "desk-linux", platform: "linux", arch: "x64" }, ip: "203.0.113.24", yourIp: "203.0.113.24", startedAt: at(-50_000), helperVersion: "1.3.0", expiresAt: at(9 * MIN), scopes: { agent: true, answer: true } }],
    ["QRSTVWXZ", { label: "build-box", machine: { hostname: "build-07", platform: "linux", arch: "arm64" }, ip: "198.51.100.77", yourIp: "203.0.113.24", startedAt: at(-3 * MIN), helperVersion: "1.3.0", expiresAt: at(7 * MIN), scopes: { agent: true, answer: false } }],
  ]);
  const norm = (code: string) => code.replace(/-/g, "").toUpperCase();
  let nextRunner = 20;

  let next = 3;
  let tokens: McpToken[] = [
    { id: 2, label: "claude code", kind: "connector", canAnswer: false, canRun: false, createdAt: new Date(NOW - 3 * DAY).toISOString(), lastUsedAt: new Date(NOW - 40 * MIN).toISOString(), expiresAt: new Date(NOW + 87 * DAY).toISOString() },
  ];
  const settles = me.role === "operator" || (me.role === "maintainer" && me.maintainerWrites);
  const list = () => ({ tokens: structuredClone(tokens), max: 5, path: "/mcp", answering: true });

  const staff = me.role !== "viewer";
  const item = (repo: string, number: number, kind: "pr" | "issue", title: string) => ({ repo, number, kind, state: "open" as const, title });
  type Row = Omit<ModelQueueCall, "pickable" | "picked"> & { pickedBy: string | null; repo: string; forLogin?: string };
  const queue: Row[] = [
    { id: 5101, repo: "photocraft", items: [item("photocraft", 10012, "pr", "Fix crash when the curves panel is closed while a preview renders")], kind: "Review pull requests", tier: "top", model: "opus", estCostUsd: 0.84, waitedMs: 11 * MIN, why: { code: "picked", text: `Picked by ${me.login}` }, pickedBy: me.login, gating: false, followUp: false },
    { id: 5102, repo: "designcraft", items: [item("designcraft", 1520, "pr", "Snap guides to the artboard edge on resize")], kind: "Review pull requests", tier: "top", model: "opus", estCostUsd: 0.79, waitedMs: 8 * MIN, why: { code: "picked", text: "Picked by oakmoss" }, pickedBy: "oakmoss", gating: false, followUp: false },
    { id: 5108, repo: "designcraft", forLogin: "kiri-n", items: [item("designcraft", 1484, "pr", "Add Hungarian spellchecking and nonstandard hyphenation")], kind: "Answer conversations", tier: "top", model: "opus", estCostUsd: 0.38, waitedMs: 2 * MIN, why: staff ? { code: "bound", text: "Waiting for kiri-n's Task Runner: it is busy" } : { code: "bound", text: "Waiting for the asker's own Task Runner: it is busy" }, pickedBy: null, gating: false, followUp: false },
    { id: 5103, repo: "pdfcraft", items: [item("pdfcraft", 2210, "pr", "Keep form field order when flattening annotations")], kind: "Push fix-ups", tier: "mid", model: "sonnet", estCostUsd: 0.31, waitedMs: 6 * MIN, why: { code: "session", text: "Waiting for laptop, which holds its session" }, pickedBy: null, gating: false, followUp: true },
    { id: 5104, repo: "vectorcraft", items: [item("vectorcraft", 873, "issue", "Boolean union drops the last subpath of compound shapes"), item("vectorcraft", 880, "issue", "Union of overlapping circles leaves a sliver")], kind: "Ask decisions", tier: "top", model: "opus", estCostUsd: 0.42, waitedMs: 19 * MIN, why: { code: "manual-only", text: "Every ready Task Runner is Manual only" }, pickedBy: null, gating: false, followUp: false, lastError: "the harness exited with code 1: rate limited" },
    { id: 5105, repo: "filmcraft", items: [item("filmcraft", 3301, "pr", "Trim clips on the timeline with the keyboard")], kind: "Classify new and changed items", tier: "small", model: "haiku", estCostUsd: 0.004, waitedMs: 3 * MIN, why: { code: "busy", text: "Every Task Runner that may take it is busy" }, pickedBy: null, gating: true, followUp: false },
    { id: 5106, repo: "deckcraft", items: [item("deckcraft", 455, "pr", "Export speaker notes to the PPTX notes pane")], kind: "Review pull requests", tier: "top", model: "opus", estCostUsd: null, waitedMs: 2 * MIN, why: { code: "behind", text: "4 calls ahead" }, pickedBy: null, gating: false, followUp: false },
    { id: 5107, repo: "wordcraft", items: [item("wordcraft", 702, "issue", "Track changes lose author colours after save")], kind: "Fix issues", tier: "top", model: "opus", estCostUsd: 1.92, waitedMs: 34 * MIN, why: { code: "no-repo-access", text: "No ready Task Runner's user can take calls on wordcraft" }, pickedBy: null, gating: false, followUp: false },
  ];
  const pickMax = 3;
  const picks = () => queue.filter((r) => r.pickedBy === me.login).length;
  const view = (): ModelQueue => ({
    calls: queue.map(({ pickedBy, repo, lastError, forLogin, ...r }) => ({
      ...structuredClone(r),
      ...(staff && lastError && { lastError }),
      why: r.why.code === "picked" && !staff ? { code: "picked" as const, text: "Picked by a user" } : r.why,
      picked: pickedBy ? (staff ? { login: pickedBy } : {}) : null,
      pickable: staff && !pickedBy && !forLogin && !r.followUp && me.writeRepos.includes(repo) && picks() < pickMax,
    })),
    runners: { autopilot: 3, manual: 1, ...(staff && { manualLogins: ["oakmoss"] }) },
    me: { canPick: staff, manualOnly: settings.manualOnly, picks: picks(), pickMax },
  });
  const rowOf = (id: number) => {
    const r = queue.find((x) => x.id === id);
    if (!r) throw new Error("no such queued call");
    return r;
  };

  return {
    inference: {
      get: () => wait(structuredClone(inference)),
      async put(body) {
        if (me.role !== "operator") throw new Error("only operators change the inference mode");
        const minEffort = { ...inference.minEffort };
        for (const [t, e] of Object.entries(body.minEffort ?? {})) {
          if (e === null) delete minEffort[t as keyof typeof minEffort];
          else minEffort[t as keyof typeof minEffort] = e;
        }
        inference = { mode: body.mode ?? inference.mode, models: body.models ?? inference.models, minEffort };
        me.inference = inference.mode;
        changed();
        return wait(structuredClone(inference));
      },
    },
    meSettings: {
      get: () => wait(structuredClone(settings)),
      async put(body) {
        if (me.role === "viewer") throw new Error("viewers have no settings");
        const ok = (n: number) => Number.isInteger(n) && n >= 0 && n <= 90;
        if (body.reserve && (!ok(body.reserve.fiveHour) || !ok(body.reserve.weekly))) throw new Error("keep-free values are whole numbers from 0 to 90");
        settings = { ...settings, ...structuredClone(body), ...(body.repos && { repos: [...new Set(body.repos)].sort() }), ...(body.tasks && { tasks: TASKS.map((t) => t.id).filter((id) => body.tasks!.includes(id)) }) };
        changed();
        return wait(structuredClone(settings));
      },
    },
    runners: {
      list: () => wait({ runners: structuredClone(runners), answering: settles }),
      pending: (code) => wait(structuredClone(pending.get(norm(code)) ?? null)),
      async approve(code, label, scopes, otherMachine) {
        if (!staff) throw new Error("viewers cannot add Task Runners");
        if (scopes.answer && !settles) throw new Error("only operators, and maintainers where they may settle decisions, let a Task Runner answer decisions");
        const p = pending.get(norm(code));
        if (!p) throw new Error("no pending Task Runner login has this code");
        if (p.ip !== p.yourIp && !otherMachine) throw new Error("this login was started from another address than yours");
        if (runners.length >= 5) throw new Error("you have 5 Task Runners; revoke one first");
        pending.delete(norm(code));
        runners = [{ tokenId: nextRunner++, label: label?.trim() || p.label, slots: null, busy: null, lastError: null, readiness: null, until: null, reason: null, fresh: false, lastSeen: null, harness: null, models: {}, reserve: null, usage: null,
          machine: p.machine, helperVersion: p.helperVersion, createdAt: at(0), expiresAt: at(90 * DAY), ...scopes }, ...runners];
        changed();
        return wait({ ok: true });
      },
      async deny(code) {
        if (!pending.delete(norm(code))) throw new Error("no pending Task Runner login has this code");
        changed();
        return wait({ ok: true });
      },
      async revoke(id) {
        if (!runners.some((r) => r.tokenId === id)) throw new Error("you have no such Task Runner");
        runners = runners.filter((r) => r.tokenId !== id);
        changed();
        return wait({ ok: true });
      },
      async setScopes(id, scopes) {
        const cur = runners.find((r) => r.tokenId === id);
        if (!cur) throw new Error("you have no such Task Runner");
        if (scopes.answer && !cur.answer && !settles) throw new Error("only operators, and maintainers where they may settle decisions, let a Task Runner answer decisions");
        runners = runners.map((r) => (r.tokenId === id ? { ...r, ...scopes } : r));
        changed();
        return wait({ ok: true });
      },
    },
    modelQueue: {
      get: () => wait(view()),
      async pick(id) {
        const r = rowOf(id);
        if (!view().calls.find((c) => c.id === id)?.pickable) throw new Error("this call cannot be picked now");
        r.pickedBy = me.login;
        r.why = { code: "picked", text: `Picked by ${me.login}` };
        changed();
        return wait({ ok: true });
      },
      async unpick(id) {
        const r = rowOf(id);
        if (!r.pickedBy) throw new Error("the call is not picked");
        if (r.pickedBy !== me.login && me.role !== "operator") throw new Error("only operators clear another user's pick");
        r.pickedBy = null;
        r.why = { code: "behind", text: `${queue.indexOf(r)} calls ahead` };
        changed();
        return wait({ ok: true });
      },
    },
    mcp: {
      tokens: () => wait(list()),
      async create(label, answer = false) {
        if (me.role === "viewer") throw new Error("viewers cannot make agent tokens");
        if (answer && !settles) throw new Error("only operators and maintainers who settle make answering tokens");
        if (tokens.length >= 5) throw new Error("you have 5 connector tokens; revoke one first");
        const id = next++;
        tokens = [{ id, label: label.trim() || null, kind: "connector", canAnswer: answer, canRun: false, createdAt: new Date(NOW).toISOString(), lastUsedAt: null, expiresAt: new Date(NOW + (answer ? 7 : 90) * DAY).toISOString() }, ...tokens];
        changed();
        return wait({ ...list(), id, token: `acmcp_mock${id}${"x".repeat(36)}` });
      },
      async revoke(id) {
        if (!tokens.some((t) => t.id === id)) throw new Error("you have no such token");
        tokens = tokens.filter((t) => t.id !== id);
        changed();
        return wait(list());
      },
    },
  };
}
