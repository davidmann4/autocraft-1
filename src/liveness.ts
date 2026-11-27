// The liveness check: every open item of a pipeline-on repo must be LIVE, meaning something will move it or a person has been asked.
// An item that is neither is STUCK; a live item whose plan state and wait have not changed for a long time is LONG (a monitor
// threshold, not a pipeline wait). The runner refreshes the stored result after planner passes (refreshLiveness); the health check,
// the Stuck items page and `autocraft-server liveness` read it.
import { needsQuestion, type WaitCode } from "./core/codes.ts";
import { blockersOfWait } from "./review/blockers.ts";
import { readConfig } from "./data/control/index.ts";
import { loadLiveness, loadLivenessInputs, loadLivenessState, saveLiveness } from "./data/planner/index.ts";
import type { Liveness, LivenessInput, LivenessItem, LivenessPlanRow, LivenessVerdict } from "./data/planner/types.ts";
import type { Db } from "./db/index.ts";
import { openDb } from "./db/open.ts";

export type { Liveness, LivenessItem, LivenessVerdict };
/** Why an item is live (`live` causes) or stuck (`stuck` causes). */
export type LiveCause = "planned" | "question" | "contributor" | "external" | "parked";
export type StuckCause = "person-wait-without-question" | "no-plan" | "internal-wait";

export type PlanRowLike = Pick<LivenessPlanRow, "kind" | "state" | "itemState" | "phase" | "wait" | "waitKind" | "waitCode" | "actions" | "since">;
/** `question`: a person has been asked, which is a workflow in `recommending` or `blocked`; `started`: a live workflow works on the item. */
export type ItemFlags = { question: boolean; started: boolean };

/** Plan states a person parks on purpose, or that wait for one to pick the item: nothing is due and nobody is asked. */
const PARKED_STATES: ReadonlySet<string> = new Set(["backlog", "held-backlog", "draft", "out-of-scope", "not-started"]);
const PARKED_WAITS: ReadonlySet<WaitCode> = new Set(["repo-approval", "ended", "open-request"]);
/** Waits on a pipeline step that has no action due: nothing is working on them. */
const INTERNAL_WAITS: ReadonlySet<WaitCode> = new Set(["triage"]);

export type Verdict = { live: true; cause: LiveCause } | { live: false; cause: StuckCause };

/** Live or stuck, from the item's stored plan and the questions that name it: an action that may run moves it, a refused one does not. Pure. */
export function classify(p: PlanRowLike, f: ItemFlags): Verdict {
  if (p.actions > 0) return { live: true, cause: "planned" };
  if (f.question) return { live: true, cause: "question" };
  if (p.waitCode !== null && PARKED_WAITS.has(p.waitCode)) return { live: true, cause: "parked" };
  if (PARKED_STATES.has(p.state) || p.itemState === "held-backlog") return { live: true, cause: "parked" };
  // The automatic path stopped for a person on a PR nobody started: nobody is asked, it waits for someone to pick it up.
  const unpicked = p.kind === "pr" && !f.started;
  if (unpicked && p.state === "opus-close") return { live: true, cause: "parked" };
  if (p.wait === null) return { live: false, cause: "no-plan" };
  if (p.waitKind === "contributor") return { live: true, cause: "contributor" };
  if (p.waitKind === "person") {
    // Its person acts on GitHub, on a switch or at the sign-in, and is asked nothing.
    if (p.waitCode !== null && !needsQuestion(p.waitCode, "person")) return { live: true, cause: "external" };
    return unpicked ? { live: true, cause: "parked" } : { live: false, cause: "person-wait-without-question" };
  }
  if (p.waitCode !== null && INTERNAL_WAITS.has(p.waitCode)) return { live: false, cause: "internal-wait" };
  return { live: true, cause: "external" };
}

export const LONG_DAYS_DEFAULT = 7;
/** Minimum time between two stored results; planner passes ask for a refresh far more often. */
export const REFRESH_MS = 3 * 60_000;
const DAY_MS = 86_400_000;

/** The stored plans and the asked refs checked against `nowMs`; `input.longDays` is the settings value of the caller's snapshot. */
export function evaluateLiveness(input: LivenessInput, nowMs: number = Date.now()): Liveness {
  const longMs = input.longDays * DAY_MS;
  const items: LivenessItem[] = [];
  const causes: Record<string, number> = {};
  const open = input.plans.length;
  for (const r of input.plans) {
    const { phase, since } = r;
    const key = `${r.repo}#${r.number}`;
    // A review held by other items waits on the questions about those items.
    const asked = input.asked.has(key) || blockersOfWait(r.wait).some((b) => input.asked.has(b));
    const verdict = classify(r, { question: asked, started: input.started.has(key) });
    const base = { repo: r.repo, number: r.number, kind: r.kind, state: r.state, wait: r.wait, phase, since };
    if (!verdict.live) {
      items.push({ ...base, verdict: "stuck", cause: verdict.cause });
      causes[verdict.cause] = (causes[verdict.cause] ?? 0) + 1;
    } else if (verdict.cause !== "parked" && verdict.cause !== "question"
      // An issue waiting on an open PR does not age on its own: the PR carries the age and is counted itself.
      && !(r.kind === "issue" && r.waitCode === "open-pr") && !asked && nowMs - Date.parse(since) > longMs) {
      items.push({ ...base, verdict: "long", cause: verdict.cause });
    }
  }
  items.sort((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === "stuck" ? -1 : 1) || a.since.localeCompare(b.since) || a.repo.localeCompare(b.repo) || a.number - b.number);
  return { checkedAt: new Date(nowMs).toISOString(), stuck: items.filter((i) => i.verdict === "stuck").length, long: items.filter((i) => i.verdict === "long").length, open, causes, items };
}

export async function computeLiveness(db: Db, nowMs: number = Date.now()): Promise<Liveness> {
  return evaluateLiveness(await loadLivenessInputs(db, { longDays: (await readConfig(db, ["liveness_long_days"])).livenessLongDays }), nowMs);
}

/** Recomputes and stores the result unless one is newer than REFRESH_MS. Returns true when it ran. */
export async function refreshLiveness(db: Db, nowMs: number = Date.now(), force = false, stored?: Awaited<ReturnType<typeof loadLivenessState>>): Promise<boolean> {
  const last = Date.parse((stored === undefined ? await loadLivenessState(db) : stored)?.checkedAt ?? "");
  if (!force && Number.isFinite(last) && nowMs - last < REFRESH_MS) return false;
  const res = await computeLiveness(db, nowMs);
  await saveLiveness(db, res);
  return true;
}

/** The stored result; null before the first refresh. */
export const storedLiveness = loadLiveness;

export function printReport(l: Liveness): void {
  console.log(`liveness: ${l.open} open items checked, ${l.stuck} stuck, ${l.long} long`);
  for (const [c, n] of Object.entries(l.causes).sort()) console.log(`  stuck by cause: ${c} ${n}`);
  for (const i of l.items) console.log(`${i.verdict.padEnd(5)} ${i.repo}#${i.number} ${i.state} | wait: ${i.wait ?? "-"} | ${i.cause} | since ${i.since.slice(0, 16)}`);
}

export const commands = {
  liveness: {
    summary: "liveness [--json]: open items that are stuck (nothing due, nobody asked) or long; exit 1 when any is stuck",
    run: async (args: string[]) => {
      const db = await openDb();
      const l = await computeLiveness(db);
      if (args.includes("--json")) console.log(JSON.stringify(l, null, 2));
      else printReport(l);
      process.exit(l.stuck > 0 ? 1 : 0);
    },
  },
};
