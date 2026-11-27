// Which queued tasks an environment takes: the rules of the claim over what `loadClaimInputs` read. No statements run here.
import type { Capabilities, Requires, TaskStep } from "../../web/src/api/types.ts";
import type { ClaimInputs, ClaimPick, TaskRecord } from "../data/build/index.ts";
import { PRIVATE_STEPS, WARM_STEP } from "../data/build/index.ts";
import type { Config } from "../data/control/index.ts";
import { envSettings } from "./envs.ts";
import { taskInScope } from "../core/scope.ts";
import { warmClaim } from "./warm-queue.ts";

/**
 * Whether an environment has room for a task it would claim (the pod launcher's cluster capacity): "fit" claims it,
 * "stop" ends claiming for now (no later task is taken in its place, so priority order holds), "skip" passes over a task
 * this environment can never run but another may, and `fail` ends the task at once with that summary (no environment can run it).
 */
export type ClaimFit = (t: { id: number; repo: string; step: string; warmKey: string | null; requires: Requires }) => Promise<"fit" | "stop" | "skip" | { fail: string }>;

export type ChooseOptions = { free: number; nowMs: number; fit?: ClaimFit; config: Config; warmMinIntervalMinutes: number };
export type Chosen = { picks: ClaimPick[]; failed: { id: number; summary: string }[] };

/** Whether an environment with these capabilities can run a task with these requirements. */
export function satisfies(caps: Capabilities, req: Requires): boolean {
  if (req.os && caps.os !== req.os) return false;
  if (req.arch && caps.arch !== req.arch) return false;
  if (req.display && !caps.display) return false;
  if (req.gpu && !caps.gpu) return false;
  if (req.toolchains && !req.toolchains.every((t) => caps.toolchains.includes(t))) return false;
  if (req.minMemGb !== undefined && caps.memGb < req.minMemGb) return false;
  if (req.minDiskGb !== undefined && caps.diskGb < req.minDiskGb) return false;
  return true;
}

const SWITCHED = [["pr-build", "pr-builds"], ["nightly", "nightly"], ["screenshot", "screenshots"]] as const;

/** The settings a choice over `inputs` reads: the build switches of the candidates' repos. */
export const claimConfigKeys = (inputs: Pick<ClaimInputs, "candidates">): string[] =>
  inputs.candidates.flatMap((t) => SWITCHED.filter(([step]) => step === t.step).map(([, feature]) => `build_feature:${feature}:${t.repo}`));

/** The task builds code from a PR: its head, or an integration branch of PRs. */
const runsPrCode = (t: Pick<TaskRecord, "step" | "number">): boolean => t.step === "pr-build" || t.step === "merge-batch" || t.number !== null;

/** The refs of the items a task builds: its PR, or the members of its batch. */
function refsOf(t: TaskRecord, inputs: ClaimInputs): string[] {
  if (t.number !== null) return [`${t.repo}#${t.number}`];
  const b = inputs.batches.get(t.id);
  return b ? b.members.map((n) => `${b.repo}#${n}`) : [];
}

/**
 * Picks the oldest of the highest priority of `inputs.candidates` that the environment may run, at most
 * min(free, its slots minus the tasks it is running). A disabled, paused or unreported environment gets none.
 * The caller claims the picks with a compare-and-set.
 */
export async function chooseTasks(inputs: ClaimInputs, o: ChooseOptions): Promise<Chosen> {
  const out: Chosen = { picks: [], failed: [] };
  const env = inputs.env;
  const caps: Capabilities | null = env?.capabilities ?? null;
  if (!env || !env.enabled || !caps || env.pausedReason || !Number.isInteger(o.free) || o.free <= 0) return out;
  if (env.kind === "local-sandbox" && inputs.pendingUpdate !== null) return out;
  const kube = env.kind === "kubernetes" ? envSettings(env) : null;
  const room = Math.min(o.free, (o.fit ? env.operatorSlots : env.slots) - inputs.running);
  if (room <= 0) return out;
  for (const t of inputs.candidates) {
    if (out.picks.length >= room) break;
    if (!satisfies(caps, t.requires)) continue;
    // The warm producer builds trusted default-branch heads with the cache's write credentials: it takes nothing else, and nothing else takes its builds.
    if (!!kube?.warmWriter !== (t.step === WARM_STEP)) continue;
    // A worker's warm build fills its own warm dirs; build pods have none.
    if (kube && t.warmRole === "build" && t.step !== WARM_STEP) continue;
    let plan: TaskStep[] = t.plan;
    if (plan.some((s) => s.network === "mirror") && !kube?.crateMirror) continue;
    // A worker that holds the warm-snapshot signing key runs only default-branch code as it is: no PR, no patch, no merge batch.
    if (caps.warmSigner && (runsPrCode(t) || t.hasPatch)) continue;
    // A security finding's private tasks go only to environments an operator marked confidential, which take no PR code.
    if (env.confidential ? runsPrCode(t) : PRIVATE_STEPS.includes(t.step)) continue;
    // The CI gate of a PR build comes from its base commit.
    if (t.step === "pr-build" && t.baseSha === null) continue;
    // Untrusted-code builds run only while their feature's switch is on for the repo.
    const feature = SWITCHED.find(([step]) => step === t.step)?.[1];
    if (feature && !o.config.repo(t.repo).buildFeature(feature)) continue;
    // Operator smoke tests and the security fix's builds run anywhere; pipeline builds only where taskInScope says so.
    if (t.step !== "smoke-test" && t.step !== "fix-check" && !taskInScope(inputs.tracked.get(t.repo), refsOf(t, inputs), inputs.startedRefs)) continue;
    // A warm build waits for its repo's interval and takes the newest default-branch head, with the plan this environment runs.
    let head = t.headSha, base = t.baseSha;
    if (t.step === WARM_STEP) {
      const facts = inputs.warm.get(t.repo);
      const w = warmClaim(facts, kube!, o.nowMs, t.id, o.warmMinIntervalMinutes);
      if (!w) continue;
      [head, base, plan] = [w.head, w.head, w.plan];
      // The next candidate of this repo sees this claim.
      facts!.active++;
      facts!.newestClaimedAt = new Date(o.nowMs).toISOString();
    }
    if (o.fit) {
      const f = await o.fit({ id: t.id, repo: t.repo, step: t.step, warmKey: t.warmKey, requires: t.requires });
      if (f === "stop") break;
      if (f === "skip") continue;
      if (f !== "fit") {
        out.failed.push({ id: t.id, summary: f.fail.slice(0, 300) });
        continue;
      }
    }
    out.picks.push(t.step === WARM_STEP ? { id: t.id, head, base: base ?? undefined, plan } : { id: t.id });
  }
  return out;
}
