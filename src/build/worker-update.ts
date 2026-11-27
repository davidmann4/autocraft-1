// Updating the sandbox worker's code without killing its tasks. The worker's admin
// command replaces the code and restarts the worker, so an update waits until the
// local-sandbox environments have no claimed or running tasks. While one waits,
// `claim` hands those environments nothing, so they drain.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Db } from "../db/index.ts";
import { clearWorkerUpdate, loadBusyLocalTasks, loadWorkerUpdate, saveWorkerUpdate, validUpdateSpec } from "../data/build/index.ts";
import type { UpdateSpec } from "../data/build/index.ts";

export type { UpdateSpec };
/** Failed attempts after which the runner stops retrying a pending update until a newer deploy replaces it. */
export const MAX_FAILURES = 5;

/** The two things done to a worker; tests replace it. */
export type WorkerAdmin = {
  version(spec: UpdateSpec): Promise<string>;
  update(spec: UpdateSpec): Promise<void>;
};

export const validSpec = validUpdateSpec;

/** Only known host keys are accepted: those in `<keyFile>.known_hosts` when it exists, else the user's known_hosts. An unknown key fails the update. */
const sshArgs = (s: UpdateSpec): string[] => {
  if (!validSpec(s)) throw new Error("invalid worker update spec");
  const pinned = `${s.keyFile}.known_hosts`;
  const hostKeys = [...(existsSync(pinned) ? ["-o", `UserKnownHostsFile=${pinned}`] : []), "-o", "StrictHostKeyChecking=yes"];
  return ["-i", s.keyFile, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", ...hostKeys, s.ssh];
};

function collect(cmd: string, args: string[], input?: NodeJS.ReadableStream): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout!.on("data", (d) => (out += d));
    p.stderr!.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, out, err }));
    if (input) input.pipe(p.stdin!);
  });
}

export const sshAdmin: WorkerAdmin = {
  async version(s) {
    try {
      const r = await collect("ssh", [...sshArgs(s), "version"]);
      return r.code === 0 ? r.out.trim() : "";
    } catch {
      return "";
    }
  },
  async update(s) {
    if (!validSpec(s)) throw new Error("invalid worker update spec");
    const git = spawn("git", [`--git-dir=${s.gitDir}`, "archive", s.sha], { stdio: ["ignore", "pipe", "pipe"] });
    let gitErr = "";
    git.stderr.on("data", (d) => (gitErr += d));
    const gitDone = new Promise<number | null>((resolve, reject) => { git.on("error", reject); git.on("close", resolve); });
    // Awaited only after ssh has ended: a git that cannot start fails this update, not the process.
    void gitDone.catch(() => {});
    const r = await collect("ssh", [...sshArgs(s), "update", s.sha], git.stdout);
    const gitCode = await gitDone;
    if (gitCode !== 0) throw new Error(`git archive failed: ${gitErr.trim().slice(-300)}`);
    if (r.code !== 0) throw new Error(`worker update failed (exit ${r.code}): ${r.err.trim().slice(-300)}`);
  },
};

export async function pendingUpdate(db: Db): Promise<UpdateSpec | null> {
  return (await loadWorkerUpdate(db)).pending;
}

export async function updateFailures(db: Db): Promise<{ count: number; error: string } | null> {
  return (await loadWorkerUpdate(db)).failures;
}

/** Claimed or running tasks on the local sandbox environments, the ones whose worker the update restarts. */
export const busyTasks = async (db: Db): Promise<number> => await loadBusyLocalTasks(db);

/**
 * The deploy's entry point. Returns what happened: "current" (the worker runs this commit),
 * "updated", or "waiting" (tasks are running; the update is recorded, replacing an older pending one).
 */
export async function requestUpdate(db: Db, spec: UpdateSpec, admin: WorkerAdmin = sshAdmin): Promise<{ result: "current" | "updated" | "waiting"; busy: number }> {
  if ((await admin.version(spec)) === spec.sha) {
    await clearWorkerUpdate(db);
    return { result: "current", busy: 0 };
  }
  const busy = await busyTasks(db);
  if (busy > 0) {
    await saveWorkerUpdate(db, { pending: spec, failures: null });
    return { result: "waiting", busy };
  }
  await admin.update(spec);
  await clearWorkerUpdate(db);
  return { result: "updated", busy: 0 };
}

/** The runner's periodic check: runs a pending update once the local environments are idle. Returns true when it updated. */
export async function checkPendingUpdate(db: Db, admin: WorkerAdmin = sshAdmin, log: (m: string) => void = () => {}): Promise<boolean> {
  const { pending: spec, failures: failed } = await loadWorkerUpdate(db);
  if (!spec) return false;
  if (failed && failed.count >= MAX_FAILURES) return false;
  if (await busyTasks(db) > 0) return false;
  try {
    if ((await admin.version(spec)) !== spec.sha) await admin.update(spec);
    await clearWorkerUpdate(db);
    log(`sandbox worker updated to ${spec.sha.slice(0, 12)}`);
    return true;
  } catch (e) {
    const count = (failed?.count ?? 0) + 1;
    const error = (e as Error).message.slice(0, 400);
    await saveWorkerUpdate(db, { failures: { count, error } });
    log(`sandbox worker update to ${spec.sha.slice(0, 12)} failed (${count}/${MAX_FAILURES}): ${error}`);
    return false;
  }
}

/** True when a pending update should keep this environment from taking new tasks. */
export async function draining(db: Db, kind: string): Promise<boolean> {
  return kind === "local-sandbox" && await pendingUpdate(db) !== null;
}

export async function statusLines(db: Db): Promise<string[]> {
  const { pending: p, failures: f } = await loadWorkerUpdate(db);
  if (!p) return ["sandbox worker update: none pending"];
  const lines = [`sandbox worker update: ${p.sha.slice(0, 12)} pending (${await busyTasks(db)} tasks still running on local sandbox environments)`];
  if (f) lines.push(`  ${f.count} failed attempts${f.count >= MAX_FAILURES ? " (retries stopped until the next deploy or a manual update-code)" : ""}; last error: ${f.error}`);
  return lines;
}
