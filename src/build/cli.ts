// autocraft-server envs list | add | set | rotate-key, autocraft-server tasks list | show | cancel | enqueue-test,
// autocraft-server workspace start | list | show | run | tool | try | end (the operator's tools for workspace pods)
// Recorded as `cli`: only someone with a shell on the host can run these. Worker keys go to a
// file (mode 0600) and are printed only with --print. Text a worker sent is shown with control
// characters removed, so it cannot drive the terminal.
import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import type { CacheReport, EnvKind, KubeSettings } from "../../web/src/api/types.ts";
import { envVar } from "../env.ts";
import { trackedNames } from "../repos.ts";
import { warmLineText } from "./warm-status.ts";
import { cacheReport } from "./caches.ts";
import { BuildError, createEnv, KINDS, listEnvs, rotateKey, updateEnv } from "./envs.ts";
import { cancelTask, createTask, getTaskDetail, listTasks, memorySummary } from "./tasks.ts";
import { autoBuildSize, clearBuildSize, gib, listSizings, setBuildSize, setWarmTarget, type RepoSizing } from "./sizing.ts";
import { baseScopeRepos } from "../pilot.ts";
import { quantity } from "./pods.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";
import { inClusterApi } from "./kube-api.ts";
import { changeWarmRepos, setWarmMinInterval, warmCoverage, WARM_INTERVAL_KEY, warmMinInterval, type WarmCoverage } from "./warm-queue.ts";
import { FETCH_SCRIPT } from "../worker/rust.ts";
import { WorkspaceSession } from "./workspace-tools.ts";
import { LAYOUT_CI, warmOf } from "./workspace-layout.ts";
import { listHelpers } from "../remote/helpers.ts";
import { capReply, requestTrySession, TRY_DEADLINE_SEC, TRY_PROMPT_MAX_BYTES, TRY_STEP } from "./workspace-session.ts";
import { CLI_QUEUE_BY, enqueue, JobError } from "../runner/jobs.ts";
import { capJson, createWorkspace, describeHeader, endWorkspace, execWs, getWorkspace, LIVE_STATES, WORKSPACE_COLUMNS, type WorkspaceRow, type WsHeader } from "./workspaces.ts";

const USAGE = `usage: autocraft-server envs list
       autocraft-server envs add <id> --label TEXT --kind local-sandbox|remote --slots N [--confidential yes|no] (--out FILE | --print)
       autocraft-server envs add <id> --label TEXT --kind kubernetes --slots N [POD SETTINGS]
       autocraft-server envs set <id> [--label TEXT] [--enabled yes|no] [--slots N] [--confidential yes|no] [POD SETTINGS]
         POD SETTINGS (kubernetes): --namespace NS  --image REF|runner  --toolchain-image NAME=REF|NAME=none  --worker-url URL
           --cpu-request Q --cpu-limit Q --memory-request Q --memory-limit Q --ephemeral-request Q --ephemeral-limit Q
           --storage Q --storage-class NAME --deadline-sec N --max-step-sec N --runtime-class NAME|none --arch x86_64|aarch64
           --workspace-slots N --workspace-cpu-request Q --workspace-cpu-limit Q --workspace-memory-request Q --workspace-memory-limit Q
           --workspace-ephemeral-request Q --workspace-ephemeral-limit Q --workspace-storage Q --sccache-url URL|none
           --crate-mirror IP|none  --display yes|no  --warm-writer yes|no --cache-write-url URL|none --writer-secret NAME|none --signing-secret NAME|none
           --capacity cluster|fixed --priority-class NAME|none --node-reserve-cpu Q --node-reserve-memory Q --max-pod-memory Q
       autocraft-server envs rotate-key <id> (--out FILE | --print)
       autocraft-server envs warm-repos [add|exclude|remove <owner/name>]   (repos the warm producer builds: every pipeline repo once a publish was trimmed; add and exclude override, remove undoes either)
       autocraft-server envs warm-interval [<minutes>]   (least time between two warm builds of a repo)
       autocraft-server envs caches [--json]   (warm versions per node, placement, warm state per repo, crate mirror allowlist)
       autocraft-server tasks list [--state S] [--env ID] [--repo NAME] [--limit N]
       autocraft-server tasks show <id>
       autocraft-server tasks cancel <id>
       autocraft-server tasks mem [--days N]
       autocraft-server tasks sizes list | set <repo> [--memory Q [--limit Q] | --memory auto] [--warm-target tmpfs|pvc|none|auto] | clear <repo>   (step pod memory and warm target per repo: automatic unless set)
       autocraft-server tasks enqueue-test --env-requires linux --repo NAME --sha SHA [--build]
       autocraft-server workspace start <repo> <sha> [--env ID] [--app NAME] [--deadline-sec N]
       autocraft-server workspace list [--all]
       autocraft-server workspace show <id>
       autocraft-server workspace run <id> -- <command...>     (in the runner container: needs pods/exec)
       autocraft-server workspace tool <id> <tool> '<json args>'  (a session tool call, as a session makes it; same container)
       autocraft-server workspace try <repo> <sha> --item N --prompt TEXT [--workspace ID] [--env ID] --for LOGIN [--keep] [--deadline-sec N]
         (queues a test session job; its log has the result)
       autocraft-server workspace end <id>`;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** `--name value` options; every option takes a value except those in `flags`. */
function options(args: string[], flags: string[] = []): { pos: string[]; opt: Map<string, string> } {
  const pos: string[] = [];
  const opt = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) pos.push(a);
    else if (flags.includes(a.slice(2))) opt.set(a.slice(2), "1");
    else if (args[i + 1] === undefined) die(`${a} needs a value`);
    else opt.set(a.slice(2), args[++i]!);
  }
  return { pos, opt };
}

const safe = (s: string | null | undefined): string => (s ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]+/g, "?");

/** Opens the key file first (exclusive, 0600), so a mistake in the path stops before anything changes. */
function keyFile(opt: Map<string, string>): { write: (key: string) => void; remove: () => void } {
  const out = opt.get("out");
  if (!out && !opt.has("print")) die("give --out FILE (mode 0600) or --print for the worker key");
  let fd: number | null = null;
  if (out) {
    try {
      fd = openSync(out, "wx", 0o600);
    } catch (e) {
      die(`cannot create ${out}: ${(e as NodeJS.ErrnoException).code ?? "error"} (it must not exist yet)`);
    }
  }
  return {
    write(key) {
      if (fd !== null) {
        writeSync(fd, `${key}\n`);
        closeSync(fd);
        fd = null;
        console.log(`worker key written to ${out}`);
      }
      if (opt.has("print")) console.log(key);
    },
    remove() {
      if (fd !== null && out) {
        closeSync(fd);
        unlinkSync(out);
      }
    },
  };
}

const POD_OPTIONS: Record<string, keyof KubeSettings> = {
  namespace: "namespace", image: "image", "worker-url": "workerUrl", "cpu-request": "cpuRequest", "cpu-limit": "cpuLimit", "memory-request": "memoryRequest",
  "memory-limit": "memoryLimit", "ephemeral-request": "ephemeralRequest", "ephemeral-limit": "ephemeralLimit", storage: "storage", "storage-class": "storageClass",
  "deadline-sec": "deadlineSec", "max-step-sec": "maxStepSec", "runtime-class": "runtimeClassName", arch: "arch",
  "workspace-slots": "workspaceSlots", "workspace-cpu-request": "workspaceCpuRequest", "workspace-cpu-limit": "workspaceCpuLimit",
  "workspace-memory-request": "workspaceMemoryRequest", "workspace-memory-limit": "workspaceMemoryLimit", "workspace-ephemeral-request": "workspaceEphemeralRequest",
  "workspace-ephemeral-limit": "workspaceEphemeralLimit", "workspace-storage": "workspaceStorage", "sccache-url": "sccacheUrl",
  "crate-mirror": "crateMirror", "warm-writer": "warmWriter", display: "display", "cache-write-url": "cacheWriteUrl", "writer-secret": "writerSecret", "signing-secret": "signingSecret",
  capacity: "capacity", "priority-class": "priorityClassName", "node-reserve-cpu": "nodeReserveCpu", "node-reserve-memory": "nodeReserveMemory", "max-pod-memory": "maxPodMemory",
};
const NULLABLE = new Set<keyof KubeSettings>(["runtimeClassName", "sccacheUrl", "crateMirror", "cacheWriteUrl", "writerSecret", "signingSecret", "priorityClassName"]);

/** The pod settings given as options, for a kubernetes environment; undefined when none is given. `--toolchain-image` merges into `current`. */
function podSettings(opt: Map<string, string>, current: KubeSettings | null): Partial<KubeSettings> | undefined {
  const out: Record<string, unknown> = {};
  for (const [name, key] of Object.entries(POD_OPTIONS)) {
    if (!opt.has(name)) continue;
    const v = opt.get(name)!;
    if ((key === "warmWriter" || key === "display") && v !== "yes" && v !== "no") die(`--${name} must be yes or no`);
    out[key] = key === "deadlineSec" || key === "maxStepSec" || key === "workspaceSlots" ? Number(v) : key === "warmWriter" || key === "display" ? v === "yes"
      : (key === "image" && v === "runner") || (NULLABLE.has(key) && v === "none") ? null : v;
  }
  if (opt.has("toolchain-image")) {
    const m = /^([^=]+)=(.+)$/.exec(opt.get("toolchain-image")!) ?? die("--toolchain-image takes NAME=REF or NAME=none");
    const images: Record<string, string | null> = { ...(current?.toolchainImages ?? {}) };
    if (m[2] === "none") delete images[m[1]!];
    else images[m[1]!] = m[2]!;
    out.toolchainImages = images;
  }
  return Object.keys(out).length ? (out as Partial<KubeSettings>) : undefined;
}

const settingsLine = (s: KubeSettings): string =>
  `namespace ${s.namespace}, image ${s.image ?? "the runner's own"}, toolchains ${Object.entries(s.toolchainImages).map(([t, i]) => `${t}=${i}`).join(" ") || "none"}, ` +
  `capacity ${s.capacity}${s.capacity === "cluster" ? ` (node reserve cpu ${s.nodeReserveCpu}, memory ${s.nodeReserveMemory})` : ""}, priority class ${s.priorityClassName ?? "none"}, ` +
  `step cpu ${s.cpuRequest}/${s.cpuLimit}, memory ${s.memoryRequest}/${s.memoryLimit} (at most ${s.maxPodMemory}), ephemeral ${s.ephemeralRequest}/${s.ephemeralLimit}, volume ${s.storage} (${s.storageClass}), ` +
  `deadline ${s.deadlineSec} s, step limit ${s.maxStepSec} s${s.runtimeClassName ? `, runtime class ${s.runtimeClassName}` : ""}, ` +
  `workspaces ${s.workspaceSlots} (cpu ${s.workspaceCpuRequest}/${s.workspaceCpuLimit}, memory ${s.workspaceMemoryRequest}/${s.workspaceMemoryLimit}, ` +
  `ephemeral ${s.workspaceEphemeralRequest}/${s.workspaceEphemeralLimit}, volume ${s.workspaceStorage}), display ${s.display ? "yes" : "no"}, compile cache ${s.sccacheUrl ?? "none"}, crate mirror ${s.crateMirror ?? "none"}` +
  (s.warmWriter ? `, warm writer (writes ${s.cacheWriteUrl}, credentials ${s.writerSecret}, signing key ${s.signingSecret})` : "");

/** A yes|no option as a boolean; undefined when it is not given. */
function yesNo(opt: Map<string, string>, name: string): boolean | undefined {
  if (!opt.has(name)) return undefined;
  const v = opt.get(name);
  if (v !== "yes" && v !== "no") die(`--${name} must be yes or no`);
  return v === "yes";
}

async function run<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof BuildError) die(e.message);
    throw e;
  }
}

async function envs(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const db = await openDb();
  if (sub === "list") {
    for (const e of await listEnvs(db)) {
      const c = e.capabilities;
      console.log(`${e.id.padEnd(16)} ${safe(e.label).padEnd(24)} ${e.kind.padEnd(14)} ${e.enabled ? (e.online ? "online " : "offline") : "disabled"} ${e.running}/${e.slots} slots${e.confidential ? "  confidential" : ""}  ${c ? `${c.os}/${c.arch} ${c.cpus} cpu ${c.memGb} GB ${c.toolchains.join(",")}` : "no report yet"}${e.pausedReason ? `  paused: ${safe(e.pausedReason)}` : ""}`);
      if (e.settings) console.log(`${"".padEnd(16)} ${settingsLine(e.settings)}`);
      for (const m of c?.warmErrors ?? []) console.log(`${"".padEnd(16)} warm: ${safe(m)}`);
      for (const w of c?.warm ?? []) console.log(`${"".padEnd(16)} ${warmLineText(w)}`);
    }
  } else if (sub === "add") {
    const { pos, opt } = options(rest, ["print"]);
    if (!pos[0] || !opt.get("label") || !opt.get("kind") || !opt.get("slots")) die(USAGE);
    if (!KINDS.includes(opt.get("kind") as EnvKind)) die(`--kind must be ${KINDS.join(" or ")}`);
    const confidential = yesNo(opt, "confidential");
    if (opt.get("kind") === "kubernetes") {
      const settings = podSettings(opt, null);
      const { env } = await run(async () => await createEnv(db, { id: pos[0], label: opt.get("label"), kind: "kubernetes", slots: Number(opt.get("slots")), ...(confidential !== undefined && { confidential }), ...(settings && { settings }) }, "cli"));
      console.log(`environment ${env.id} created (no worker key: the runner starts its pods)\n${settingsLine(env.settings!)}`);
      if (!env.settings!.image && !envVar("IMAGE")) console.log("note: this shell has no AUTOCRAFT_IMAGE; the runner must have it, or set --image");
      return;
    }
    if (podSettings(opt, null)) die("pod settings are only for --kind kubernetes");
    const f = keyFile(opt);
    try {
      const { env, key } = await (async () => await createEnv(db, { id: pos[0], label: opt.get("label"), kind: opt.get("kind"), slots: Number(opt.get("slots")), ...(confidential !== undefined && { confidential }) }, "cli"))();
      f.write(key!);
      console.log(`environment ${env.id} created`);
    } catch (e) {
      f.remove();
      if (e instanceof BuildError) die(e.message);
      throw e;
    }
  } else if (sub === "set") {
    const { pos, opt } = options(rest);
    if (!pos[0]) die(USAGE);
    const input: Record<string, unknown> = {};
    if (opt.has("label")) input.label = opt.get("label");
    if (opt.has("slots")) input.slots = Number(opt.get("slots"));
    for (const name of ["enabled", "confidential"]) {
      const v = yesNo(opt, name);
      if (v !== undefined) input[name] = v;
    }
    const settings = podSettings(opt, (await listEnvs(db)).find((x) => x.id === pos[0])?.settings ?? null);
    if (settings) input.settings = settings;
    if (!Object.keys(input).length) die(USAGE);
    const e = await run(async () => await updateEnv(db, pos[0], input, "cli"));
    console.log(`${e.id}: ${safe(e.label)}, ${e.enabled ? "enabled" : "disabled"}, ${e.slots} slots${e.confidential ? ", confidential" : ""}`);
    if (e.settings) console.log(settingsLine(e.settings));
  } else if (sub === "warm-repos") {
    if (rest.length === 1 || rest.length > 2 || (rest.length === 2 && !["add", "exclude", "remove"].includes(rest[0]!))) die(USAGE);
    const cov = rest.length === 2 ? await run(async () => await changeWarmRepos(db, rest[0] as "add" | "exclude" | "remove", rest[1]!, "cli")) : await warmCoverage(db);
    printCoverage(cov);
  } else if (sub === "caches") {
    const { pos, opt } = options(rest, ["json"]);
    if (pos.length) die(USAGE);
    const r = await cacheReport(db, []);
    if (opt.has("json")) console.log(JSON.stringify(r, null, 2));
    else printCaches(r);
  } else if (sub === "warm-interval") {
    if (rest.length > 1) die(USAGE);
    if (rest[0] !== undefined) await run(async () => await setWarmMinInterval(db, rest[0]!, "cli"));
    console.log(`${WARM_INTERVAL_KEY} ${await warmMinInterval(db)}`);
  } else if (sub === "rotate-key") {
    const { pos, opt } = options(rest, ["print"]);
    if (!pos[0]) die(USAGE);
    const f = keyFile(opt);
    try {
      f.write((await rotateKey(db, pos[0], "cli")).key);
      console.log("the old key no longer works");
    } catch (e) {
      f.remove();
      if (e instanceof BuildError) die(e.message);
      throw e;
    }
  } else die(USAGE);
}

const OS = ["linux", "macos", "windows"];

const MEMORY_WHY: Record<RepoSizing["memorySource"], string> = { operator: "override", history: "automatic", oom: "automatic, raised after an OOM kill", environment: "automatic: the environment's" };

/** One repo's effective step memory and warm target, each marked automatic or override. */
function sizingLine(r: RepoSizing): string {
  const mem = r.memory ? `${gib(r.memory.requestBytes)} / ${gib(r.memory.limitBytes)}` : "environment's";
  const hist = r.history ? `${r.history.builds} builds: ${gib(r.history.requestBytes)} / ${gib(r.history.limitBytes)}` : "fewer than 3 measured builds";
  const memWhy = r.memorySource === "operator" ? `override (automatic would be from ${hist})` : r.memorySource === "environment" ? `${MEMORY_WHY.environment}, ${hist}` : `${MEMORY_WHY[r.memorySource]} (${hist})`;
  const version = r.warmBytes ? `${(r.warmBytes / 1e9).toFixed(1)} GB version` : "no version yet";
  const warmWhy = r.warmSource === "operator" ? `override (automatic would be ${r.autoWarmTarget}, ${version})` : `automatic (${version})`;
  return `${safe(r.repo).padEnd(24)} memory ${mem}, ${memWhy}; warm ${r.warmTarget}, ${warmWhy}${r.reason && r.updatedAt ? `  [${r.updatedAt.slice(0, 16)} ${safe(r.reason)}]` : ""}`;
}

const ago = (at: string | null): string => {
  if (!at) return "never";
  const m = Math.round((Date.now() - Date.parse(at)) / 60_000);
  return m < 120 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

function printCaches(r: CacheReport): void {
  const name = (x: { key: string; repo: string | null }) => safe(x.repo ?? x.key);
  console.log(`nodes (read ${ago(r.readAt)})`);
  if (!r.nodes.length) console.log("  (no node reports a warm status)");
  for (const n of r.nodes) {
    const fs = n.fs ? `disk ${n.fs.usedPct}% of ${gib(n.fs.sizeBytes)}` : "disk unknown";
    const warm = n.warmBytes ? `warm ${gib(n.warmBytes.current)}${n.warmBytes.grace ? ` + ${gib(n.warmBytes.grace)} in grace` : ""}` : "";
    console.log(`  ${safe(n.node)}  ${n.fresh ? "" : "STALE  "}updated ${ago(n.updated)}  ${fs}  ${warm}`);
    if (n.error) console.log(`    error: ${safe(n.error)}`);
    for (const k of n.keys) console.log(`    holds ${name(k)} ${k.commit.slice(0, 12)} ${gib(k.bytes)}${k.newest ? "" : "  (older version)"}${k.placed === false ? "  (not placed here)" : ""}`);
    for (const p of n.pending) console.log(`    pending ${name(p)}: ${safe(p.why)}`);
    for (const b of n.badBlobs) console.log(`    bad blobs ${name(b)}: ${b.count}`);
  }
  console.log(r.placement ? "placement" : `placement: none${r.placementNote ? ` (${safe(r.placementNote)})` : ", every node keeps every key warm-assign lists"}`);
  for (const p of r.placement ?? []) console.log(`  ${name(p)}  ${p.nodes.map((n) => `${safe(n.node)} ${n.holds === "newest" ? "holds it" : n.holds === "older" ? "holds an older version" : "not yet"}${n.fresh ? "" : " (stale)"}`).join(", ") || "no node"}`);
  if (r.placement && r.placementNote) console.log(`  note: ${safe(r.placementNote)}`);
  console.log(r.writer ? `repos (warm builds on ${safe(r.writer.env)}, image ${safe(r.writer.image ?? "unknown")})` : "repos (no enabled warm writer)");
  for (const x of r.repos) {
    const last = x.last ? `last task ${x.last.id} ${x.last.state}${x.last.endedAt ? ` ${ago(x.last.endedAt)}` : ""}` : "no warm task";
    console.log(`  ${safe(x.repo)}  ${x.freshness}  ${x.coverage}  target ${x.warmTarget}${x.warmTargetSource === "operator" ? " (set)" : ""}${x.bytes ? ` ${gib(x.bytes)}` : ""}  on ${x.nodes}/${x.of} nodes  ${last}`);
    if (x.last?.state === "failed" && x.last.summary) console.log(`    ${safe(x.last.summary).slice(0, 200)}`);
  }
  if (r.mirror) {
    console.log(`crate mirror git allowlist (read ${ago(r.mirror.readAt)}; used by ${r.mirror.envs.map(safe).join(", ") || "no environment"})`);
    if (r.mirror.error) console.log(`  error: ${safe(r.mirror.error)}`);
    for (const repo of r.mirror.allowlist ?? []) console.log(`  ${safe(repo)}`);
  }
}

function printCoverage(c: WarmCoverage): void {
  console.log(c.allSince ? `every pipeline repo since the first trimmed publish (${c.allSince.slice(0, 16)})` : "only added repos until a publish is trimmed");
  for (const r of c.repos) console.log(`  ${safe(r.repo)}  ${r.why === "added" ? "override: added" : "automatic: pipeline"}`);
  if (!c.repos.length) console.log("  (none)");
  if (c.added.length) console.log(`added: ${c.added.map(safe).join(", ")}`);
  if (c.excluded.length) console.log(`excluded: ${c.excluded.map(safe).join(", ")}`);
}

async function sizes(db: Db, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const { pos, opt } = options(rest);
  const bytes = (name: string): number | null => {
    if (!opt.has(name)) return null;
    const b = quantity(opt.get(name)!);
    return b > 0 ? b : die(`--${name} must be a Kubernetes quantity such as 6Gi`);
  };
  if (sub === "list") {
    const rows = await listSizings(db, await baseScopeRepos(db));
    if (!rows.length) console.log("no repo in the pipeline scope: step pods get their environment's memory");
    for (const r of rows) console.log(sizingLine(r));
  } else if (sub === "set") {
    const autoMemory = opt.get("memory") === "auto";
    const memory = autoMemory ? null : bytes("memory");
    const warm = opt.get("warm-target");
    if (!pos[0] || (memory === null && !autoMemory && warm === undefined)) die(USAGE);
    if (autoMemory) {
      const was = await autoBuildSize(db, pos[0], "cli");
      console.log(`${safe(pos[0])}: step memory automatic${was ? "" : " (it was)"}`);
    } else if (memory !== null) {
      const m = await run(async () => await setBuildSize(db, pos[0]!, memory, bytes("limit"), "cli"));
      console.log(`${safe(pos[0]!)}: step memory ${gib(m.requestBytes)} requested, ${gib(m.limitBytes)} limit (each at most the environment's max pod memory)`);
    }
    if (warm !== undefined) {
      await run(async () => await setWarmTarget(db, pos[0]!, warm, "cli"));
      console.log(`${safe(pos[0]!)}: warm target ${safe(warm)}`);
    }
  } else if (sub === "clear") {
    if (!pos[0]) die(USAGE);
    console.log(await clearBuildSize(db, pos[0], "cli") ? `${safe(pos[0])}: step memory and warm target automatic` : `${safe(pos[0])} had no setting of its own`);
  } else die(USAGE);
}

async function tasks(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const db = await openDb();
  if (sub === "list") {
    const { opt } = options(rest);
    const page = await run(async () => await listTasks(db, { state: opt.get("state") as never, env: opt.get("env"), repo: opt.get("repo"), limit: Number(opt.get("limit")) || 20 }));
    for (const t of page.tasks) {
      console.log(`${String(t.id).padStart(5)} ${t.state.padEnd(9)} ${t.repo.padEnd(16)} ${t.headSha.slice(0, 8)} ${(t.envId ?? "-").padEnd(12)} ${t.queuedAt.slice(0, 16)} ${safe(t.summary)}`);
    }
  } else if (sub === "show") {
    const id = Number(rest[0]);
    if (!Number.isInteger(id)) die(USAGE);
    const t = await getTaskDetail(db, id) ?? die("no such task");
    console.log(`task ${t.id}  ${t.state}${t.cancelRequested ? " (cancel requested)" : ""}  ${t.repo}${t.number ? `#${t.number}` : ""} @ ${t.headSha}`);
    console.log(`requires ${JSON.stringify(t.requires)}  priority ${t.priority}  env ${t.envId ?? "-"}  queued ${t.queuedAt}${t.endedAt ? `  ended ${t.endedAt}` : ""}`);
    for (const s of t.plan) {
      const r = t.results.find((x) => x.step === s.name);
      console.log(`  step ${safe(s.name)}: ${safe(s.cmd.join(" "))}  [network ${s.network}, ${s.timeoutSec} s]${r ? `  exit ${r.exitCode ?? "-"}${r.timedOut ? " (timed out)" : ""}, ${r.durationMs} ms${r.peakMemBytes !== undefined ? `, peak ${(r.peakMemBytes / 1e9).toFixed(2)} GB` : ""}${r.oomKilled ? " (out of memory)" : ""}` : ""}`);
    }
    if (t.summary) console.log(`summary: ${safe(t.summary)}`);
    for (const a of t.artifacts) console.log(`artifact ${a.name} ${a.bytes} bytes ${a.contentType}`);
    if (t.logTail) console.log(`--- log (last ${t.logTail.length} characters of ${t.logBytes} bytes) ---\n${t.logTail.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "?")}`);
  } else if (sub === "cancel") {
    const id = Number(rest[0]);
    if (!Number.isInteger(id)) die(USAGE);
    const t = await run(async () => await cancelTask(db, id, "cli"));
    console.log(`task ${id}: ${t.state === "cancelled" ? "cancelled" : "cancel requested"}`);
  } else if (sub === "mem") {
    const { opt } = options(rest);
    const days = Number(opt.get("days") ?? 30);
    if (!Number.isFinite(days) || days <= 0) die(USAGE);
    const gb = (b: number) => (b / 1e9).toFixed(2);
    const rows = await memorySummary(db, days);
    if (rows.length === 0) console.log(`no steps with memory data in the last ${days} days`);
    else {
      console.log(`${"repo".padEnd(20)} ${"step".padEnd(16)} ${"steps".padStart(5)} ${"median GB".padStart(10)} ${"max GB".padStart(8)} ${"oom".padStart(4)}`);
      for (const r of rows) console.log(`${safe(r.repo).padEnd(20)} ${safe(r.step).padEnd(16)} ${String(r.steps).padStart(5)} ${gb(r.medianBytes).padStart(10)} ${gb(r.maxBytes).padStart(8)} ${String(r.oom).padStart(4)}`);
    }
  } else if (sub === "sizes") {
    await sizes(db, rest);
  } else if (sub === "enqueue-test") {
    await enqueueTest(db, rest);
  } else die(USAGE);
}

/**
 * A smoke-test task: system facts with no network, then the cargo version. `--build` instead fetches the crates and builds
 * the workspace's tests (`cargo test --no-run`) in the rust-stable toolchain with the CI gate of that commit, as the pipeline's builds do.
 */
async function enqueueTest(db: Db, args: string[]): Promise<void> {
  const { opt } = options(args, ["build"]);
  const os = opt.get("env-requires");
  const repo = opt.get("repo");
  const sha = opt.get("sha");
  if (!os || !repo || !sha) die(USAGE);
  if (!OS.includes(os)) die(`--env-requires must be one of ${OS.join(", ")}`);
  if (!(await trackedNames(db)).includes(repo)) die(`${repo} is not a tracked repo`);
  const vis = (await db.get(db.k.selectFrom("main.repos").select("visibility").where("name", "=", repo)))?.visibility;
  if (vis?.toLowerCase() !== "public") die(`${repo} is not public; workers fetch source anonymously`);
  const build = opt.has("build");
  const id = await run(async () => await createTask(db, {
    // A build reads the CI gate at the commit itself, so it gets the gate's env and compile cache as CI's run of that commit.
    step: "smoke-test", repo, headSha: sha, ...(build ? { baseSha: sha } : {}), requires: { os: os as "linux" | "macos" | "windows", ...(build ? { toolchains: ["rust-stable"] } : {}) },
    plan: build
      ? [
          { name: "fetch deps", cmd: ["sh", "-c", FETCH_SCRIPT], network: "fetch", timeoutSec: 900 },
          { name: "build tests", cmd: ["cargo", "test", "--workspace", "--no-run", "--offline", "--locked"], network: "none", timeoutSec: 7200 },
        ]
      : [
          { name: "system", cmd: ["sh", "-c", "uname -a; nproc; free -g"], network: "none", timeoutSec: 60 },
          { name: "cargo version", cmd: ["cargo", "--version"], network: "none", timeoutSec: 60 },
        ],
  }));
  console.log(`task ${id} queued`);
}

async function workspace(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const db = await openDb();
  const idOf = (v: string | undefined): number => {
    const id = Number(v);
    return Number.isInteger(id) && id > 0 ? id : die(USAGE);
  };
  const line = (w: WorkspaceRow) =>
    `${String(w.id).padStart(5)} ${w.state.padEnd(9)} ${safe(w.repo).padEnd(16)} ${w.base_sha.slice(0, 8)} ${w.env_id.padEnd(12)} ${(w.node ?? "-").padEnd(14)} ${w.created_at.slice(0, 16)} ${safe(w.owner)}`;
  /** --env, or the one enabled kubernetes environment. */
  const envOf = async (opt: Map<string, string>): Promise<string> => {
    const given = opt.get("env");
    if (given) return given;
    const k = (await listEnvs(db)).filter((e) => e.kind === "kubernetes" && e.enabled && !e.settings?.warmWriter);
    if (k.length !== 1) die(`give --env: ${k.length ? `${k.length} kubernetes environments are enabled` : "no kubernetes environment is enabled"}`);
    return k[0]!.id;
  };
  if (sub === "start") {
    const { pos, opt } = options(rest);
    const [repo, sha] = pos;
    if (!repo || !sha) die(USAGE);
    if (!(await trackedNames(db)).includes(repo)) die(`${repo} is not a tracked repo`);
    const envId = await envOf(opt);
    const deadline = opt.has("deadline-sec") ? Number(opt.get("deadline-sec")) : undefined;
    const id = await run(async () => await createWorkspace(db, { repo, baseSha: sha, envId, app: opt.get("app") ?? null, ...(deadline !== undefined && { limits: { deadlineSec: deadline } }), owner: "cli" }));
    console.log(`workspace ${id} requested on ${envId}`);
  } else if (sub === "list") {
    const { opt } = options(rest, ["all"]);
    let q = db.k.selectFrom("workspaces").select(WORKSPACE_COLUMNS).orderBy("id", "desc").limit(50);
    if (!opt.has("all")) q = q.where("state", "in", LIVE_STATES);
    for (const w of await db.all(q)) console.log(line(w));
  } else if (sub === "show") {
    const w = await getWorkspace(db, idOf(rest[0])) ?? die("no such workspace");
    console.log(line(w));
    console.log(`base ${w.base_sha}${w.base_commit ? ` (in the pod ${w.base_commit})` : ""}${w.app ? `  app ${safe(w.app)}` : ""}  limits ${w.limits}`);
    console.log(`pod ${w.pod ?? "-"}  volume ${w.pvc ?? "-"}  since ${w.state_at}${w.last_call_at ? `  last call ${w.last_call_at}` : ""}${w.ended_at ? `  ended ${w.ended_at}` : ""}`);
    const size = (await db.get(db.k.selectFrom("workspaces").select((eb) => eb.fn<number | null>("length", ["checkpoint"]).as("bytes")).where("id", "=", w.id)))?.bytes;
    console.log(`checkpoint ${size != null ? `${size} bytes at ${w.checkpoint_at}` : "none"}`);
    if (w.layout === LAYOUT_CI) {
      const warm = warmOf(w);
      console.log(`layout 2 (CI paths)  warm target ${warm?.target ?? "-"}  volume ${warm ? `${(warm.storageBytes / 1024 ** 3).toFixed(0)} GiB` : "-"}  ${warm?.note ? safe(warm.note) : warm?.use ? `copying ${warm.use.key}@${warm.use.commit.slice(0, 12)} on ${warm.use.node}` : warm?.why ? `cold: ${safe(warm.why)}` : w.prepared ? "" : "reading the CI gate"}`);
    }
    if (w.error) console.log(`error: ${safe(w.error)}`);
    const reply = await db.get(db.k.selectFrom("workspace_sessions as s").innerJoin("remote_calls as c", "c.id", "s.remote_call_id").select(["s.id", "c.reply"])
      .where("s.workspace_id", "=", w.id).where("s.kind", "=", "try").where("c.reply", "is not", null).orderBy("s.id", "desc").limit(1));
    if (reply?.reply?.trim()) console.log(`reply of try session ${reply.id}:\n${safe(capReply(reply.reply.trim()))}`);
    const calls = await db.all(db.k.selectFrom("workspace_calls").select(["id", "n", "tool", "state", "created_at", "finished_at", "result"]).where("workspace_id", "=", w.id).orderBy("id", "desc").limit(10));
    for (const c of calls.reverse()) {
      let summary = "";
      try {
        const r = JSON.parse(c.result ?? "{}") as { header?: WsHeader | null; error?: string; text?: string };
        summary = r.error ?? (typeof r.text === "string" ? r.text.split("\n", 1)[0]!.slice(0, 120) : describeHeader(r.header ?? null));
      } catch { /* not JSON */ }
      console.log(`  call ${c.id}${c.n !== null ? ` (ws ${c.n})` : ""} ${safe(c.tool)} ${c.state} ${c.created_at.slice(11, 19)}  ${safe(summary)}`);
    }
  } else if (sub === "run") {
    const id = idOf(rest[0]);
    const sep = rest.indexOf("--");
    const cmd = sep >= 0 ? rest.slice(sep + 1) : [];
    if (sep !== 1 || !cmd.length) die(USAGE);
    const api = inClusterApi() ?? die("this shell is not in the cluster: run it in the runner container, whose service account may exec in workspace pods");
    const r = await run(async () => await execWs(db, api, id, ["run", "120", "--", ...cmd], { tool: "cli", args: { argv: cmd.slice(0, 40) }, timeoutMs: 130_000, touch: true }));
    console.log(r.header ? `WS ${describeHeader(r.header)}${r.n !== null ? ` (call ${r.n})` : ""}` : "no helper header");
    if (r.output) process.stdout.write(r.output.endsWith("\n") ? r.output : `${r.output}\n`);
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.error) console.error(`exec: ${r.error}`);
  } else if (sub === "tool") {
    const id = idOf(rest[0]);
    const name = rest[1] ?? die(USAGE);
    let args: unknown;
    try {
      args = JSON.parse(rest[2] ?? "{}");
    } catch {
      die("the arguments must be JSON");
    }
    if (!await getWorkspace(db, id)) die("no such workspace");
    const api = inClusterApi() ?? die("this shell is not in the cluster: run it in the runner container, whose service account may exec in workspace pods");
    const at = new Date().toISOString();
    const row = Number((await db.get(db.k.insertInto("workspace_calls").values({ workspace_id: id, tool: name, args: JSON.stringify(capJson(args)), state: "queued", created_at: at }).returning("id")))!.id);
    const r = await new WorkspaceSession(db, api, id).call(name, args, row);
    console.log(`call ${row}${r.isError ? " (error)" : ""}`);
    process.stdout.write(r.text.endsWith("\n") ? r.text : `${r.text}\n`);
    for (const im of r.images ?? []) console.log(`[image ${im.mimeType}, ${Buffer.from(im.data, "base64").length} bytes]`);
  } else if (sub === "try") {
    const { pos, opt } = options(rest, ["keep"]);
    const [repo, sha] = pos;
    const item = Number(opt.get("item"));
    const prompt = opt.get("prompt");
    const forLogin = opt.get("for");
    if (!repo || !sha || pos.length !== 2 || !prompt || !forLogin || !Number.isInteger(item)) die(USAGE);
    if ((await listHelpers(db, forLogin)).length === 0) die(`${forLogin} has no registered Task Runner`);
    const workspaceId = opt.has("workspace") ? idOf(opt.get("workspace")) : null;
    const deadlineSec = opt.has("deadline-sec") ? Number(opt.get("deadline-sec")) : undefined;
    if (deadlineSec !== undefined && !(Number.isInteger(deadlineSec) && deadlineSec >= TRY_DEADLINE_SEC.min && deadlineSec <= TRY_DEADLINE_SEC.max)) die(`--deadline-sec must be ${TRY_DEADLINE_SEC.min} to ${TRY_DEADLINE_SEC.max}`);
    if (Buffer.byteLength(prompt, "utf8") > TRY_PROMPT_MAX_BYTES) die(`--prompt is at most ${TRY_PROMPT_MAX_BYTES} bytes`);
    // A given workspace brings its own environment.
    const envId = workspaceId === null ? await envOf(opt) : opt.get("env") ?? "";
    const session = await run(async () => await requestTrySession(db, { repo, baseSha: sha, item, prompt, envId, keep: opt.has("keep"), ...(deadlineSec !== undefined && { deadlineSec }), workspaceId, forLogin, by: "cli" }));
    try {
      // Queued, not run here: the runner runs the job, so a runner restart resumes it.
      const job = await enqueue(db, TRY_STEP, { repo, session }, CLI_QUEUE_BY);
      // Recorded now so the session sweep sees a job that ends before it starts; a job that already claimed it keeps it.
      await db.run(db.k.updateTable("workspace_sessions").set({ job_id: job.id }).where("id", "=", session).where("job_id", "is", null));
      console.log(`session ${session}: job ${job.id} queued; its log has the result`);
    } catch (e) {
      const why = (e as Error).message ?? String(e);
      await db.run(db.k.updateTable("workspace_sessions").set({ state: "failed", outcome: `not queued: ${why}`.slice(0, 300), ended_at: new Date().toISOString() })
        .where("id", "=", session).where("job_id", "is", null));
      if (!(e instanceof JobError)) throw e;
      die(`session ${session} not queued: ${why}`);
    }
  } else if (sub === "end") {
    const id = idOf(rest[0]);
    console.log(await endWorkspace(db, id) ? `workspace ${id} ended; the launcher deletes its pod and volume` : `workspace ${id} is not live`);
  } else die(USAGE);
}

export const commands = {
  envs: { summary: "build environments: list | add <id> | set <id> | rotate-key <id> | warm-repos | warm-interval [<minutes>] | caches", run: async (args: string[]) => await envs(args) },
  tasks: { summary: "build tasks: list | show <id> | cancel <id> | mem | sizes list|set|clear | enqueue-test", run: async (args: string[]) => await tasks(args) },
  workspace: { summary: "workspace pods: start <repo> <sha> | list | show <id> | run <id> -- <cmd> | tool <id> <tool> <json> | try <repo> <sha> | end <id>", run: async (args: string[]) => await workspace(args) },
};
