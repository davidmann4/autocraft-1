// The runner leader keeps the item snapshot on its own disk current. The snapshot's readers (the leader's job processes
// and the item tools its worker API answers) run beside the leader, while the sync may run in another pod: so the leader
// builds it, once at start and again after each sync run that finished since its last build. A build runs as a child
// process, so its file writes never hold the leader's event loop; the snapshot's file lock keeps two builds apart.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Db } from "../db/index.ts";
import { dbEnv, dbTarget } from "../db/open.ts";

const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));
const CHECK_MS = 10_000;
const TAIL = 2000;

/** The end time of the newest sync run that succeeded, null when there is none. */
async function lastSync(db: Db): Promise<string | null> {
  return (await db.get(db.k.selectFrom("sync_runs").select((eb) => eb.fn.max<string | null>("ended_at").as("t")).where("error", "is", null)))?.t ?? null;
}

/** One build by `autocraft-server item-tools snapshot`; resolves with its summary line, rejects with its output's end. */
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
      else reject(new Error(`exited ${code ?? sig}: ${text.slice(-300)}`));
    });
  });
}

/**
 * Keeps the item snapshot current until `signal` aborts: a build at start, then one whenever a newer successful sync run
 * has ended. A failed build is logged and waits for the next sync run. Writes nothing to the database.
 */
export function keepSnapshot(db: Db, signal: AbortSignal, log: (line: string) => void, opts: { everyMs?: number; build?: (signal: AbortSignal) => Promise<string> } = {}): void {
  const build = opts.build ?? buildChild;
  let seen: string | null | undefined;
  let busy = false;
  const check = async () => {
    if (busy || signal.aborted) return;
    busy = true;
    try {
      const t = await lastSync(db);
      if (seen !== undefined && t === seen) return;
      seen = t;
      log(`item snapshot: ${await build(signal)}`);
    } catch (e) {
      if (!signal.aborted) log(`item snapshot failed: ${String((e as Error).message).slice(0, 300)}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void check(), opts.everyMs ?? CHECK_MS);
  timer.unref();
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  void check();
}
