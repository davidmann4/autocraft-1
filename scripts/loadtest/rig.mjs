// The load rig: a scratch dashboard (fresh data directory), a fault-injection proxy, a ledger the fake
// harnesses report to, N Task Runners (worker/autocraft.mjs with the fake harness), and a driver that queues calls the way a
// job process does. No external services: helpers run with scripts/loadtest/preload.mjs, which answers the plan-usage
// endpoint itself and blocks every other non-loopback request.
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { setPriority } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startProxy } from "./proxy.mjs";

const here = import.meta.dirname;
export const ROOT = resolve(here, "../..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkdir = (d) => { mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };

export function freePort() {
  return new Promise((ok, no) => { const s = createNetServer(); s.on("error", no); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
}

/** Percentile of a list of numbers (nearest rank); null for an empty list. */
export const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p / 100 * s.length) - 1))]; };

// The mix of calls: prompt, tier, share, and the fake harness's delay in seconds before time compression (Opus-like 60-300 s,
// Haiku-like 5-20 s). `gating` calls are the ones the plan wants answered within a minute at p95.
export const MIX = [
  { id: "review.opus", tier: "top", share: 0.22, secs: [60, 300], model: "opus" },
  { id: "premerge.opus", tier: "top", share: 0.06, secs: [60, 200], model: "opus" },
  { id: "referee.sonnet", tier: "mid", share: 0.12, secs: [20, 90], model: "sonnet" },
  { id: "classify.haiku", tier: "small", share: 0.25, secs: [5, 20], model: "haiku" },
  { id: "priority.haiku", tier: "small", share: 0.10, secs: [5, 20], model: "haiku" },
  { id: "dupes.haiku", tier: "small", share: 0.05, secs: [5, 20], model: "haiku" },
  { id: "lint.reference.haiku", tier: "small", share: 0.20, secs: [2, 8], model: "haiku", gating: true },
];

export class Rig {
  /**
   * @param {{ name: string, dir: string, users: number, parallel: number, timeFactor: number, timeScale?: number, dbFrom?: string, faults?: object, repos?: number, helpersFile?: string }} o
   */
  constructor(o) {
    this.o = { repos: 4, timeScale: 1, ...o };
    // The scale reaches the dashboard and the helpers through their environment, and this process (the driver) through its own:
    // src/remote/time-scale.ts reads it when first imported.
    this.ts = this.o.timeScale;
    if (this.ts < 1) process.env.AUTOCRAFT_REMOTE_TIME_SCALE = String(this.ts); else delete process.env.AUTOCRAFT_REMOTE_TIME_SCALE;
    this.dir = mkdir(join(o.dir, o.name));
    this.t0 = Date.now();
    this.helpers = [];
    this.calls = new Map(); // nonce -> { id, promptId, tier, gating, followUp, enqueuedAt }
    this.ledger = new Map(); // nonce -> [{ ev, at, pid }]
    this.events = []; // timeline lines for the report
    this.dashLog = createWriteStream(join(this.dir, "dashboard.log"), { flags: "a" });
  }
  /** Real milliseconds for a duration given at production scale. */
  sc(ms) { return Math.max(1, Math.round(ms * this.ts)); }
  /** The env entry for a child process. */
  scaleEnv() { return this.ts < 1 ? { AUTOCRAFT_REMOTE_TIME_SCALE: String(this.ts) } : {}; }
  note(line) { const l = `[${((Date.now() - this.t0) / 1000).toFixed(0).padStart(5)} s] ${line}`; this.events.push(l); console.log(l); }

  async init() {
    const o = this.o;
    this.dashPort = await freePort(); this.proxyPort = await freePort(); this.controlPort = await freePort(); this.ledgerPort = await freePort();
    this.dbPath = join(mkdir(join(this.dir, "data")), "mirror.db");
    if (o.dbFrom) {
      const src = new DatabaseSync(o.dbFrom, { readOnly: true });
      src.exec(`VACUUM INTO '${this.dbPath.replace(/'/g, "''")}'`);
      src.close();
    }
    // The ledger: what the fake harnesses report.
    this.ledgerServer = createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c);
      try { const m = JSON.parse(Buffer.concat(chunks).toString()); const l = this.ledger.get(m.nonce) ?? []; l.push(m); this.ledger.set(m.nonce, l); } catch { /* ignore */ }
      res.writeHead(200).end("ok");
    });
    await new Promise((r) => this.ledgerServer.listen(this.ledgerPort, "127.0.0.1", r));
    this.proxyLog = join(this.dir, "proxy.jsonl");
    writeFileSync(this.proxyLog, "");
    this.proxy = startProxy({ listen: this.proxyPort, target: `http://127.0.0.1:${this.dashPort}`, control: this.controlPort, log: this.proxyLog, faults: o.faults });
    await this.startDashboard();
    await this.setupDb();
    await this.proxy.start();
    this.permTimer = setInterval(() => this.refreshPermissions(), this.sc(15_000));
    this.sampleTimer = setInterval(() => this.sample(), this.sc(15_000));
    this.samples = [];
    this.note(`scratch instance up: dashboard :${this.dashPort}, proxy :${this.proxyPort}, control :${this.controlPort}, data ${this.dir}`);
  }

  // ---- dashboard -------------------------------------------------------------------------------------------------

  async startDashboard() {
    const home = mkdir(join(this.dir, "dashhome"));
    const env = {
      PATH: process.env.PATH, HOME: home, XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_CONFIG_HOME: join(home, "config"),
      AUTOCRAFT_DEV_AUTH: "1", AUTOCRAFT_LISTEN: `127.0.0.1:${this.dashPort}`, AUTOCRAFT_DB: this.dbPath, AUTOCRAFT_DEV_PERMS: join(this.dir, "perms.json"), ...this.scaleEnv(),
    };
    writeFileSync(join(this.dir, "perms.json"), "{}");
    this.dash = spawn(process.execPath, [...(process.env.RIG_DASH_PROF ? ["--cpu-prof", `--cpu-prof-dir=${process.env.RIG_DASH_PROF}`] : []), join(ROOT, "src/cli.ts"), "dash", "serve"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    this.dash.stdout.pipe(this.dashLog, { end: false }); this.dash.stderr.pipe(this.dashLog, { end: false });
    const dash = this.dash;
    this.dashExit = new Promise((r) => dash.on("exit", r));
    for (let i = 0; i < 300; i++) {
      try { await fetch(`http://127.0.0.1:${this.dashPort}/healthz`, { signal: AbortSignal.timeout(1000) }); return; } catch { /* not up yet */ }
      if (dash.exitCode !== null) throw new Error(`the dashboard exited with ${dash.exitCode}; see ${join(this.dir, "dashboard.log")}`);
      await sleep(200);
    }
    throw new Error("the dashboard did not start in 60 s");
  }
  async stopDashboard(signal = "SIGTERM") {
    if (!this.dash || this.dash.exitCode !== null) return;
    // This process only: by the time the fallback fires, `this.dash` may be the restarted dashboard.
    const dash = this.dash, exit = this.dashExit;
    dash.kill(signal);
    const kill = setTimeout(() => dash.kill("SIGKILL"), 15_000);
    await exit;
    clearTimeout(kill);
  }
  async restartDashboard() { this.note("dashboard restart"); await this.stopDashboard(); await this.startDashboard(); this.note("dashboard back"); }
  /** The dashboard is gone for `seconds` (the proxy keeps answering 502). */
  async dashboardOutage(seconds) { this.note(`dashboard stopped for ${seconds} s`); await this.stopDashboard(); await sleep(seconds * 1000); await this.startDashboard(); this.note("dashboard back"); }

  // ---- database, users, tokens -------------------------------------------------------------------------------------

  async setupDb() {
    this.db = (await import(join(ROOT, "src/db.ts"))).connect(this.dbPath);
    const mode = await import(join(ROOT, "src/remote/mode.ts"));
    const tokens = await import(join(ROOT, "src/dash/mcp/tokens.ts"));
    this.repos = Array.from({ length: this.o.repos }, (_, i) => `rigrepo${i + 1}`);
    this.users = [];
    const now = new Date().toISOString();
    for (let i = 0; i < this.o.users; i++) {
      const login = `rig-user-${String(i + 1).padStart(2, "0")}`;
      this.db.prepare("INSERT OR REPLACE INTO main.access (login, role, added_by, added_at) VALUES (?, 'maintainer', 'rig', ?)").run(login, now);
      const { token, row } = tokens.createToken(this.db, login, "rig", { kind: "runner" });
      this.users.push({ login, token, tokenId: row.id });
    }
    this.refreshPermissions();
  }
  /** Write permission of every user on every repo, kept fresh: the claim reads it from the cache when no dashboard session exists. */
  refreshPermissions() {
    const now = new Date().toISOString();
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const st = this.db.prepare("INSERT OR REPLACE INTO main.repo_permissions (login, repo, permission, checked_at) VALUES (?, ?, 'write', ?)");
      for (const u of this.users) for (const r of this.repos) st.run(u.login, r, now);
      this.db.exec("COMMIT");
    } catch { try { this.db.exec("ROLLBACK"); } catch { /* ignore */ } }
  }

  // ---- helpers ---------------------------------------------------------------------------------------------------

  /** Starts helper `i` (0-based). `failing`: its harness always fails. */
  startHelper(i, { parallel = this.o.parallel, failing = false } = {}) {
    const u = this.users[i];
    const hd = mkdir(join(this.dir, "helpers", `h${i + 1}`));
    const home = mkdir(join(hd, "home")), cfg = mkdir(join(hd, "config")), cache = mkdir(join(hd, "cache")), bin = mkdir(join(hd, "bin"));
    const harness = join(bin, "claude");
    let src = readFileSync(join(here, "fake-harness.mjs"), "utf8");
    if (failing) src = src.replace("const ALWAYS_FAIL = false;", "const ALWAYS_FAIL = true;");
    writeFileSync(harness, src, { mode: 0o755 }); chmodSync(harness, 0o755);
    const server = `http://127.0.0.1:${this.proxyPort}`;
    mkdir(join(cfg, "autocraft-runner"));
    writeFileSync(join(cfg, "autocraft-runner", "config.json"), JSON.stringify({ server, harness: "claude", claudeToken: "rig-fake-token" }), { mode: 0o600 });
    // The runner credential as `autocraft login` stores it once approved.
    writeFileSync(join(cfg, "autocraft-runner", "credentials.json"), JSON.stringify({ server, credential: u.token, label: u.login, state: "approved" }), { mode: 0o600 });
    const env = {
      PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: cfg, XDG_CACHE_HOME: cache, AUTOCRAFT_RUNNER_CLAUDE_BIN: harness, ...this.scaleEnv(),
      NODE_OPTIONS: `--import=${join(here, "preload.mjs")}`,
    };
    const h = { i, login: u.login, tokenId: u.tokenId, dir: hd, failing, parallel, env, proc: null, log: join(hd, "helper.log"), stopped: false, restarts: 0 };
    this.helpers[i] = h;
    this.spawnHelper(h);
    return h;
  }
  spawnHelper(h) {
    const out = createWriteStream(h.log, { flags: "a" });
    // Its own process group, so SIGSTOP and SIGKILL reach the harnesses and sandboxes below it as a laptop sleep or a crash would.
    h.proc = spawn(process.execPath, [join(ROOT, "worker/autocraft.mjs"), "work", "--parallel", String(h.parallel)], { cwd: ROOT, env: h.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    h.proc.stdout.pipe(out); h.proc.stderr.pipe(out);
    h.proc.on("exit", () => out.end());
    h.pid = h.proc.pid;
    // In production Task Runners run on users' machines, not beside the dashboard: here they yield the CPU to it. The
    // harnesses and sandboxes they start inherit the priority.
    try { setPriority(h.pid, 15); } catch { /* exited already */ }
  }
  signalHelper(i, sig) { const h = this.helpers[i]; try { process.kill(-h.pid, sig); } catch { /* gone */ } }
  killHelper(i) { this.note(`helper ${i + 1} SIGKILL`); this.signalHelper(i, "SIGKILL"); }
  restartHelper(i) { const h = this.helpers[i]; h.restarts++; this.note(`helper ${i + 1} restart`); this.spawnHelper(h); }
  async freezeHelper(i, seconds) {
    this.note(`helper ${i + 1} SIGSTOP for ${seconds} s`); this.signalHelper(i, "SIGSTOP");
    await sleep(seconds * 1000);
    this.signalHelper(i, "SIGCONT"); this.note(`helper ${i + 1} resumed`);
  }

  // ---- calls -----------------------------------------------------------------------------------------------------

  /** Queues one call as a job process does and returns its id. `opts.parentId` makes it a follow-up of that call. */
  async enqueue(kind, opts = {}) {
    const prompts = await import(join(ROOT, "src/prompts/index.ts"));
    const calls = await import(join(ROOT, "src/remote/calls.ts"));
    this.cache ??= { prompts, calls, parts: new Map() };
    const nonce = `n${this.calls.size + 1}-${Math.random().toString(36).slice(2, 7)}`;
    const secs = opts.secs ?? (kind.secs[0] + Math.random() * (kind.secs[1] - kind.secs[0]));
    const delayMs = Math.round(secs * 1000 * this.o.timeFactor);
    const id = kind.id;
    let parts = this.cache.parts.get(id);
    if (!parts) { parts = prompts.claudeParts(id, prompts.EXAMPLES[id].input, false, true); this.cache.parts.set(id, parts); }
    const p = prompts.CLAUDE_PROMPTS[id];
    const marker = `RIG ${JSON.stringify({ nonce, delayMs, ledger: `http://127.0.0.1:${this.ledgerPort}`, fail: !!opts.fail })}`;
    const bundle = {
      promptId: id, promptVersion: "rig", tier: kind.tier, effort: p.effort, timeoutSeconds: Math.max(600, Math.ceil(secs * 3)), maxTurns: null,
      stdin: `${marker}\n${parts.stdin}`, system: parts.system, mounts: [], mcpServers: [], keepSession: !!kind.keepSession,
      ...(opts.parentId !== undefined && { resume: { parentCallId: opts.parentId } }),
      hints: { claude: { args: prompts.claudeArgs(id, p.models[0], false, undefined, parts.system) } },
    };
    const repo = this.repos[Math.floor(Math.random() * this.repos.length)];
    const callId = calls.enqueueCall(this.db, { promptId: id, promptVersion: "rig", tier: kind.tier, effort: p.effort, askedModel: p.models[0], bundle, items: [{ repo, number: 1 + Math.floor(Math.random() * 200) }], level: 2, maxAttempts: 3, ...(opts.parentId !== undefined && { parentId: opts.parentId }) });
    this.calls.set(nonce, { id: callId, nonce, promptId: id, tier: kind.tier, gating: !!kind.gating || opts.parentId !== undefined, followUp: opts.parentId !== undefined, keepSession: !!kind.keepSession, enqueuedAt: Date.now(), delayMs });
    return callId;
  }

  /** Queues `n` calls of the mix at once (a queued backlog) and keeps the calls alive like a job process: seen_at and lease expiry. */
  /** Queues `n` calls of the mix; with `rampMs`, spread evenly over that long (jobs queue their calls as they go), else at once. */
  async enqueueMix(n, { followUps = 0.1, rampMs = 0 } = {}) {
    const pick = () => { let r = Math.random(); for (const k of MIX) { if ((r -= k.share) <= 0) return k; } return MIX[3]; };
    const kinds = Array.from({ length: n }, pick);
    this.startJobEmulator();
    const t0 = Date.now();
    for (const [i, k] of kinds.entries()) {
      if (rampMs > 0) { const due = t0 + (i * rampMs) / n; if (due > Date.now()) await sleep(due - Date.now()); }
      // A few Opus calls keep their session so a follow-up turn can resume it.
      await this.enqueue(k.tier === "top" && Math.random() < followUps * 2 ? { ...k, keepSession: true } : k);
    }
  }
  startJobEmulator() {
    if (this.jobTimer) return;
    this.jobTimer = setInterval(async () => {
      try {
        const now = Date.now();
        // What each polling caller does every 3 s (src/remote/calls.ts pollCall): touch seen_at, end lost leases.
        this.db.prepare("UPDATE main.remote_calls SET seen_at = ? WHERE state IN ('queued', 'leased')").run(now);
        this.cache.calls.expireLeases(this.db, now);
        await this.collectDone();
      } catch (e) { this.note(`job emulator: ${e.message}`); }
    }, Math.max(250, this.sc(3000)));
  }
  /** Queues a follow-up for every finished call that kept its session. */
  async collectDone() {
    for (const c of this.calls.values()) {
      if (c.final || c.followUp) continue;
      const r = this.db.prepare("SELECT state FROM main.remote_calls WHERE id = ?").get(c.id);
      if (r && (r.state === "done" || r.state === "failed")) {
        c.final = r.state;
        if (r.state === "done" && c.keepSession && !c.followed) {
          c.followed = true;
          const k = MIX.find((m) => m.tier === "small" && !m.gating);
          await this.enqueue({ ...k, id: "classify.haiku", gating: true }, { parentId: c.id, secs: 4 });
        }
      }
    }
  }
  openCalls() { return this.db.prepare("SELECT COUNT(*) AS n FROM main.remote_calls WHERE state IN ('queued','leased')").get().n; }
  async waitDrained(maxMs) {
    const end = Date.now() + maxMs;
    while (Date.now() < end) { if (this.openCalls() === 0) return true; await sleep(2000); }
    return false;
  }

  // ---- sampling and report ---------------------------------------------------------------------------------------------

  /** Every 15 s: which helpers hold no lease while calls wait, and whether the dashboard shows why. */
  sample() {
    try {
      const now = Date.now();
      const queued = this.db.prepare("SELECT COUNT(*) AS n FROM main.remote_calls WHERE state = 'queued'").get().n;
      const leased = new Map(this.db.prepare("SELECT token_id AS t, COUNT(*) AS n FROM main.remote_calls WHERE state = 'leased' GROUP BY token_id").all().map((r) => [Number(r.t), Number(r.n)]));
      const st = new Map(this.db.prepare("SELECT token_id AS t, readiness, reason, last_error, reported_at AS at FROM main.remote_helpers").all().map((r) => [Number(r.t), r]));
      // Cool-off is per login (src/remote/cooloff.ts).
      const cool = new Map(this.db.prepare("SELECT login, until FROM main.remote_cooloffs").all().map((r) => [String(r.login).toLowerCase(), r.until === null ? 0 : Number(r.until)]));
      const idle = [];
      for (const h of this.helpers) {
        if (!h) continue;
        const s = st.get(h.tokenId);
        const holds = (leased.get(h.tokenId) ?? 0) > 0;
        const down = h.proc.exitCode !== null || h.frozen;
        const why = down ? "helper not running (shown as offline)" : (cool.get(h.login.toLowerCase()) ?? 0) > now ? "cooled off" : s && s.readiness !== "ready" ? `${s.readiness}: ${s.reason ?? ""}` : s?.last_error ? "last error shown" : null;
        h.idleFor = !holds && queued > 0 && !down ? (h.idleFor ?? now) : null;
        // Idle for over 90 s with calls waiting, ready, no reason shown: nobody can tell why it does nothing.
        if (h.idleFor && now - h.idleFor > this.sc(90_000) && !why) idle.push(h.i + 1);
      }
      this.samples.push({ t: now, queued, idleNoReason: idle });
    } catch { /* sampling is best effort */ }
  }

  async stop() {
    clearInterval(this.permTimer); clearInterval(this.sampleTimer); clearInterval(this.jobTimer);
    for (const h of this.helpers) if (h) { try { process.kill(-h.pid, "SIGKILL"); } catch { /* gone */ } }
    await this.stopDashboard();
    await this.proxy.stop();
    this.ledgerServer.close();
    try { this.db.close(); } catch { /* ignore */ }
  }
}
