// The runner leader keeps the item snapshot on its own disk current. The snapshot's readers (the leader's job processes
// and the item tools its worker API answers) run beside the leader, while the sync may run in another pod: so the leader
// builds it, once at start and again after each sync run or embed job that finished since its last build. Embed jobs
// leave the refresh to it, so a job never waits for a build. A build runs as a child
// process, so its file writes never hold the leader's event loop; the snapshot's file lock keeps two builds apart.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "../db/index.ts";
import { dbEnv, dbTarget } from "../db/open.ts";
import { loadLastEndedJob } from "../data/jobs/index.ts";
import { loadLastSyncEnd } from "../data/mirror/index.ts";
import { errorLine, SNAPSHOT_FAILED, snapshotFile } from "./snapshot.ts";

const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));
const CHECK_MS = 10_000;
const TAIL = 2000;
const MESSAGE_MAX = 1000;

/** Why a build exited: its failure line, or else the last lines of its output that are not stack frames. */
function failureText(out: string): string {
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  const own = lines.findLast((l) => l.startsWith(SNAPSHOT_FAILED));
  if (own) return own.slice(SNAPSHOT_FAILED.length);
  return lines.filter((l) => !l.startsWith("at ") && !l.startsWith("Node.js v")).slice(-3).join(" / ");
}

/** One build by `autocraft-server item-tools snapshot`; resolves with its summary line, rejects with why it failed. */
function buildChild(signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", CLI, "item-tools", "snapshot"], { stdio: ["ignore", "pipe", "pipe"], env: dbEnv(dbTarget()) });
    let out = "";
    const take = (b: Buffer) => void (out = (out + b.toString()).slice(-TAIL));
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    // A stopping or fenced runner leaves no build behind; the next build removes its partial file.
    const kill = () => { try { child.kill("SIGKILL"); } catch { /* gone */ } };
    signal.addEventListener("abort", kill, { once: true });
    process.once("exit", kill);
    const done = () => (signal.removeEventListener("abort", kill), process.removeListener("exit", kill));
    child.on("error", (e) => (done(), reject(e)));
    child.on("exit", (code, sig) => {
      done();
      const text = out.trim();
      if (code === 0) resolve(text.split("\n").pop() ?? "");
      else reject(new Error(`exited ${code ?? sig}: ${failureText(text)}`));
    });
  });
}

/**
 * Keeps the item snapshot current until `signal` aborts: a build at start, then one whenever a newer successful sync run
 * or a newer embed job has ended, or the snapshot has a journal (a refresh was interrupted, or is running and the build waits for it). A failed build is logged and waits for the next sync run or embed job. Writes nothing to the database.
 */
export function keepSnapshot(db: Db, signal: AbortSignal, log: (line: string) => void, opts: { everyMs?: number; build?: (signal: AbortSignal) => Promise<string> } = {}): void {
  const build = opts.build ?? buildChild;
  let seen: string | undefined;
  let busy = false;
  const check = async () => {
    if (busy || signal.aborted) return;
    busy = true;
    try {
      const [sync, embed] = await db.together(() => Promise.all([loadLastSyncEnd(db), loadLastEndedJob(db, "embed")]));
      const t = `${sync ?? ""}|${embed ?? ""}`;
      // A journal left by a refresh that was killed keeps read-only readers out until a build rolls it back.
      if (seen !== undefined && t === seen && !existsSync(`${snapshotFile()}-journal`)) return;
      seen = t;
      log(`item snapshot: ${await build(signal)}`);
    } catch (e) {
      if (!signal.aborted) log(`${SNAPSHOT_FAILED}${errorLine(e).slice(0, MESSAGE_MAX)}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void check(), opts.everyMs ?? CHECK_MS);
  timer.unref();
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  void check();
}
