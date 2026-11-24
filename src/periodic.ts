// `autocraft-server periodic [command ...]`: runs the periodic chores of a container install (deploy/periodic.sh: sync
// every minute, the SQLite snapshot once a day) while this copy leads the periodic role (src/db/leader.ts), so of two
// replicas only one runs them. The chores run as a child in a process group of their own, fenced to this copy's epoch.
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { elect, LOST_LEADER_EXIT } from "./db/leader.ts";
import { setFence } from "./db/fence.ts";
import { closeDb, openDb, setDbRole } from "./db/open.ts";

const LOOP = fileURLToPath(new URL("../deploy/periodic.sh", import.meta.url));
/**
 * How long a stop lets a sync or backup in progress finish before the chores are killed, so the lease is released before
 * the pod's termination grace period (40 s) ends and the standby takes over at once instead of after the lease expires.
 * An interrupted sync is simply run again by the next leader.
 */
const STOP_GRACE_MS = 20_000;

const killGroup = (pid: number, signal: NodeJS.Signals): void => {
  try { process.kill(-pid, signal); } catch { /* already gone */ }
};

async function periodic(args: string[]): Promise<void> {
  const [cmd, ...rest] = args.length ? args : ["/bin/bash", LOOP];
  setDbRole("periodic");
  const db = await openDb();
  const ac = new AbortController();
  process.once("SIGTERM", () => ac.abort());
  process.once("SIGINT", () => ac.abort());
  const lease = await elect(db, "periodic", { signal: ac.signal });
  if (!lease) {
    await closeDb();
    console.log("periodic: stopped while standby");
    process.exit(0);
  }
  if (lease.epoch) setFence({ role: "periodic", epoch: lease.epoch });
  const child = spawn(cmd!, rest, { detached: true, stdio: "inherit", env: process.env });
  // Fencing: the chores stop at once and this process exits, so the container restarts as a standby.
  lease.lost.addEventListener("abort", () => {
    if (child.pid) killGroup(child.pid, "SIGKILL");
    writeSync(2, `periodic: lost the leader lease (${String((lease.lost.reason as Error | undefined)?.message ?? "")}); chores killed, exiting\n`);
    process.exit(LOST_LEADER_EXIT);
  }, { once: true });
  // A stop reaches the loop alone, which lets a sync or backup in progress finish and then exits; one still running after
  // STOP_GRACE_MS is killed with the loop.
  ac.signal.addEventListener("abort", () => {
    try { child.kill("SIGTERM"); } catch { /* gone */ }
    setTimeout(() => { if (child.pid && child.exitCode === null && child.signalCode === null) killGroup(child.pid, "SIGKILL"); }, STOP_GRACE_MS).unref();
  }, { once: true });
  const code = await new Promise<number>((resolve) => {
    child.on("error", (e) => (console.error(`periodic: ${cmd} did not start: ${e.message}`), resolve(1)));
    child.on("exit", (c, sig) => resolve(c ?? (sig === "SIGTERM" || (sig === "SIGKILL" && ac.signal.aborted) ? 0 : 1)));
  });
  await lease.release();
  await closeDb();
  process.exit(ac.signal.aborted ? 0 : code);
}

export const commands = {
  periodic: {
    summary: "periodic [command ...]: run the periodic chores (default deploy/periodic.sh) while this copy leads them; another copy waits as a standby",
    run: periodic,
  },
};
