// The fetch_dependencies tool. A workspace has no network, so a session that adds or bumps a crate asks AutoCraft to fetch
// it: a short-lived pod with network `mirror` (src/build/workspace-pods.ts workspaceFetchPodSpec) on the workspace's volume
// runs `cargo fetch`, which updates Cargo.lock and CARGO_HOME there, through the crate mirror only. The tool then returns the
// Cargo.lock changes against the base commit, read in the workspace pod. Without a crate mirror it refuses: there is no
// fallback to the public network. The pod is deleted when the fetch ends; one left behind by a job that died, or by a
// workspace parked or ended meanwhile, is deleted by the launcher's pass (fetchPodKept).
import type { Db } from "../db/index.ts";
import { envVar } from "../env.ts";
import type { ExecResult, KPod, KubeApi } from "./kube-api.ts";
import { loadEnvs } from "../data/build/index.ts";
import { envSettings } from "./envs.ts";
import { MIRROR_WAIT_CONTAINER, PULL_REASONS } from "./pods.ts";
import { cutMiddle, seconds } from "./workspace-tool-specs.ts";
import { ciLayoutOf, workspaceImages } from "./workspace-launch.ts";
import {
  FETCH_CONTAINER, FETCH_DEADLINE_SEC, FETCH_LIMIT_SEC, FETCH_LOG_TAIL, FETCH_START_MS, fetchPodName, fetchSelector, workspaceFetchPodSpec,
} from "./workspace-pods.ts";
import { cleanOutput, execInWorkspace, getWorkspace, type WorkspaceRow } from "./workspaces.ts";
import { effect } from "../db/effects.ts";

/** How long the call may take in all: the pod's start, its deadline and the diff, as the call row's deadline. */
export const FETCH_CALL_MS = FETCH_START_MS + FETCH_DEADLINE_SEC * 1000 + 60_000;
const POLL_MS = 2000;
/** cargo's output a successful fetch returns, from its end. */
const OK_LOG_BYTES = 4 * 1024;

export type FetchResult = { text: string; isError?: boolean };
export type FetchOptions = { pollMs?: number; now?: () => number; defaultImage?: string | null };

const refused = (text: string): FetchResult => ({ text: `refused: ${text}`, isError: true });
const failed = (text: string): FetchResult => ({ text: `failed: ${text}`, isError: true });

/** The pod's terminated container named `name`, init containers included. */
const terminated = (p: KPod, name: string) =>
  [...(p.status?.initContainerStatuses ?? []), ...(p.status?.containerStatuses ?? [])].find((x) => x.name === name)?.state?.terminated;

/** Runs cargo fetch in `dir` (a path in the workspace) for workspace call `row`; never throws for an outcome of the fetch. */
export async function fetchDependencies(db: Db, api: KubeApi, workspaceId: number, row: number, dir: string, o: FetchOptions = {}): Promise<FetchResult> {
  const now = o.now ?? Date.now;
  const w = await getWorkspace(db, workspaceId);
  if (!w) return refused(`there is no workspace ${workspaceId}`);
  const s = envSettings((await loadEnvs(db, { ids: [w.env_id] }))[0] ?? { settings: null });
  if (!s.crateMirror) {
    return refused(`the environment ${w.env_id} has no crate mirror (its crateMirror setting is unset), so nothing can be fetched; if the change needs a crate that is not in the workspace, report blocked with "needs dependencies"`);
  }
  if (w.state !== "ready" || !w.pod || !w.pvc) return refused(`the workspace is ${w.state}`);
  const images = workspaceImages(s, o.defaultImage === undefined ? envVar("IMAGE") ?? null : o.defaultImage);
  if (typeof images === "string") return failed(images);
  const ns = s.namespace;
  const name = fetchPodName(w.pod, row);
  const started = now();
  // A job that restarted mid-fetch finds the pod it made and waits for it instead of fetching again.
  const prior = (await api.listPods(ns, fetchSelector(w.id))).find((p) => p.metadata.name === name && !p.metadata.deletionTimestamp);
  if (!prior) {
    const ci = ciLayoutOf(w) ?? undefined;
    effect("build-launch");
    await api.createPod(ns, workspaceFetchPodSpec({ s, envId: w.env_id, id: w.id, ...images, name, pvc: w.pvc, ...(ci ? { ci } : {}), dir }));
  }
  try {
    const pod = await finished(db, api, w, ns, name, started, o.pollMs ?? POLL_MS, now);
    if (typeof pod === "string") return failed(pod);
    const ms = now() - started;
    const log = cleanOutput(Buffer.from(await api.podLog(ns, name, FETCH_CONTAINER, FETCH_LOG_TAIL + 1024).catch(() => "")));
    if (pod.status?.phase !== "Succeeded") return failed(failure(pod, log, ms));
    return await lockDiff(db, api, w, log, ms);
  } finally {
    await api.deletePod(ns, name).catch(() => {});
  }
}

/** Waits until the fetch pod has ended; a string says why it will not. */
async function finished(db: Db, api: KubeApi, w: WorkspaceRow, ns: string, name: string, started: number, pollMs: number, now: () => number): Promise<KPod | string> {
  const pause = () => new Promise((r) => setTimeout(r, pollMs));
  for (;;) {
    let pods: KPod[];
    // A failed read (the API server busy or restarting) is read again until the call's deadline; the pod keeps running.
    try {
      pods = await api.listPods(ns, fetchSelector(w.id));
    } catch (e) {
      if (now() - started > FETCH_CALL_MS) return `the fetch pod could not be read: ${cleanOutput(Buffer.from((e as Error).message)).slice(0, 300)}`;
      await pause();
      continue;
    }
    const p = pods.find((x) => x.metadata.name === name);
    if (!p) return "the fetch pod is gone (the workspace was parked or ended, or the pod was deleted); call fetch_dependencies again";
    const phase = p.status?.phase;
    if (phase === "Succeeded" || phase === "Failed") return p;
    const at = now();
    const statuses = [...(p.status?.initContainerStatuses ?? []), ...(p.status?.containerStatuses ?? [])];
    const pull = statuses.find((x) => PULL_REASONS.has(x.state?.waiting?.reason ?? ""));
    if (pull && at - started > FETCH_START_MS) return `the fetch pod's container ${pull.name} could not start: ${pull.state!.waiting!.reason}`;
    if (!p.status?.startTime && at - started > FETCH_START_MS) {
      const sched = p.status?.conditions?.find((c) => c.type === "PodScheduled" && c.status === "False");
      return `the fetch pod did not start within ${FETCH_START_MS / 60_000} min${sched ? `: ${cleanOutput(Buffer.from(sched.message ?? sched.reason ?? "")).slice(0, 300)}` : ""}`;
    }
    if (at - started > FETCH_CALL_MS) return `the fetch did not end within ${Math.round(FETCH_CALL_MS / 60_000)} min`;
    const cur = await getWorkspace(db, w.id).catch(() => w);
    if (cur?.state !== "ready" || cur.pod !== w.pod) return `the workspace was ${cur?.state ?? "removed"} during the fetch`;
    await pause();
  }
}

/** What a failed fetch pod says: the mirror down, the time limit, or cargo's error. */
function failure(p: KPod, log: string, ms: number): string {
  const wait = terminated(p, MIRROR_WAIT_CONTAINER);
  if (wait && wait.exitCode !== 0) return "the crate mirror did not accept connections within 30 s (it may be down), so nothing was fetched; try again later, or report blocked with \"needs dependencies\"";
  const t = terminated(p, FETCH_CONTAINER);
  if (t?.exitCode === 124) return `cargo fetch did not finish within ${FETCH_LIMIT_SEC / 60} min\n${log}`;
  if (p.status?.reason === "DeadlineExceeded") return `the fetch pod passed its ${FETCH_DEADLINE_SEC / 60} min deadline\n${log}`;
  if (!t) return `the fetch pod failed before cargo ran${p.status?.message ? `: ${cleanOutput(Buffer.from(p.status.message)).slice(0, 300)}` : ""}`;
  return `cargo fetch exited ${t.exitCode} after ${seconds(ms)}\n${log || "(no output)"}`;
}

/** The Cargo.lock changes in the workspace against its base commit, read in the workspace pod. */
async function lockDiff(db: Db, api: KubeApi, w: WorkspaceRow, log: string, ms: number): Promise<FetchResult> {
  const argv = ["git", "-C", "/work/src", "diff", "--no-color", "--no-ext-diff", "--no-textconv", w.base_commit ?? "HEAD", "--", ":(glob)**/Cargo.lock"];
  const head = `cargo fetch finished in ${seconds(ms)} through the crate mirror.`;
  let r: ExecResult;
  try {
    r = await execInWorkspace(db, api, w.id, argv, { maxOut: 1024 * 1024, timeoutMs: 60_000 });
  } catch (e) {
    return { text: `${head}\nThe Cargo.lock diff could not be read: ${cleanOutput(Buffer.from((e as Error).message)).slice(0, 300)}`, isError: true };
  }
  const tail = Buffer.from(log);
  const out = log ? `\n${tail.length > OK_LOG_BYTES ? `…${cleanOutput(tail.subarray(-OK_LOG_BYTES))}` : log}` : "";
  if (r.exitCode !== 0) return { text: `${head}${out}\nThe Cargo.lock diff could not be read: git exited ${r.exitCode}\n${cleanOutput(r.stderr).slice(0, 2000)}`, isError: true };
  const diff = cleanOutput(cutMiddle(r.stdout));
  return { text: `${head}${out}\n${diff ? `Cargo.lock changes against the base commit:\n${diff}` : "No Cargo.lock changes against the base commit."}` };
}
