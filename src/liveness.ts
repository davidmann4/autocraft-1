// The liveness check: every open item of a pipeline-on repo must be LIVE, meaning something will move it or a person has been asked.
// An item that is neither is STUCK; a live item whose plan state and wait have not changed for a long time is LONG (a monitor
// threshold, not a pipeline wait). The runner refreshes the stored result after planner passes (refreshLiveness); the health check,
// the Stuck items page and `autocraft-server liveness` read it.
import type { Expression, SqlBool } from "kysely";
import { fixStoppedWait, isOpenPrWait, TRIAGE_WAIT } from "./core/decide-item.ts";
import type { WaitKind } from "./core/plan.ts";
import { blockersOfWait } from "./review/blockers.ts";
import { setting, writeSetting } from "./settings-read.ts";
import type { Db } from "./db/index.ts";
import * as kx from "./db/kx.ts";
import { openDb } from "./db/open.ts";

export type LivenessVerdict = "stuck" | "long";
/** Why an item is live (`live` causes) or stuck (`stuck` causes). */
export type LiveCause = "planned" | "question" | "answered" | "dispute" | "stopped" | "contributor" | "external" | "parked";
export type StuckCause = "person-wait-without-question" | "no-plan" | "internal-wait" | "duplicate-without-question";

export type PlanRowLike = {
  kind: "pr" | "issue";
  state: string;
  itemState: string | null;
  phase: string;
  wait: string | null;
  waitKind: WaitKind | null;
  actions: number;
  since: string;
};
/** `answered`: a person answered a question about the item and the pipeline has not applied the answer yet. */
export type ItemFlags = { question: boolean; answered?: boolean; dispute: boolean; stopped: boolean };

/** Plan states a person parks on purpose: nothing is due and nobody is asked. */
const PARKED_STATES: ReadonlySet<string> = new Set(["backlog", "held-backlog", "draft", "declined", "out-of-scope"]);
const PARKED_WAITS: ReadonlySet<string> = new Set(["merge held by an operator", "stays open as a plugin candidate", "a Backlog hold", TRIAGE_WAIT]);
/** Waits on a pipeline step that has no action due: nothing is working on them. */
const INTERNAL_WAITS: ReadonlySet<string> = new Set(["the scope question to be asked", "the label referee", "Haiku's second opinion"]);
/** Person waits whose person acts on GitHub, not in a question. */
const GITHUB_PERSON_WAITS: ReadonlySet<string> = new Set(["the maintainer's review"]);

export type Verdict = { live: true; cause: LiveCause } | { live: false; cause: StuckCause };

/** Live or stuck, from the item's stored plan and the questions that name it. Pure. */
export function classify(p: PlanRowLike, f: ItemFlags): Verdict {
  if (p.actions > 0) return { live: true, cause: "planned" };
  if (f.stopped) return { live: true, cause: "stopped" };
  if (f.question) return { live: true, cause: "question" };
  if (f.dispute) return { live: true, cause: "dispute" };
  if (f.answered) return { live: true, cause: "answered" };
  if (p.wait !== null && PARKED_WAITS.has(p.wait)) return { live: true, cause: "parked" };
  if (p.itemState === "held-duplicate" || p.state === "held-duplicate" || p.state === "duplicate") return { live: false, cause: "duplicate-without-question" };
  if (PARKED_STATES.has(p.state) || p.itemState === "held-backlog") return { live: true, cause: "parked" };
  if (p.wait === null) return { live: false, cause: "no-plan" };
  if (p.waitKind === "contributor") return { live: true, cause: "contributor" };
  if (p.waitKind === "person") return GITHUB_PERSON_WAITS.has(p.wait) ? { live: true, cause: "external" } : { live: false, cause: "person-wait-without-question" };
  if (INTERNAL_WAITS.has(p.wait)) return { live: false, cause: "internal-wait" };
  return { live: true, cause: "external" };
}

export type LivenessItem = {
  repo: string; number: number; kind: "pr" | "issue";
  verdict: LivenessVerdict;
  /** Why it is stuck; for a long item, why it is live. */
  cause: string;
  state: string; wait: string | null; phase: string;
  /** When the plan state or wait last changed. */
  since: string;
};
export type Liveness = { checkedAt: string; stuck: number; long: number; open: number; causes: Record<string, number>; items: LivenessItem[] };

export const LONG_DAYS_KEY = "liveness_long_days";
export const LONG_DAYS_DEFAULT = 7;
/** Minimum time between two stored results; planner passes ask for a refresh far more often. */
export const REFRESH_MS = 3 * 60_000;
const DAY_MS = 86_400_000;

type Refs = { repo: string | null; number: number }[];

async function keySet(rows: Promise<Refs>): Promise<Set<string>> {
  return new Set((await rows).map((r) => `${r.repo}#${r.number}`));
}

/** Items that have an open question, a disputed answer, or a stopped step, by `repo#number`. */
export async function flagSets(db: Db): Promise<{ question: Set<string>; answered: Set<string>; dispute: Set<string>; stopped: Set<string> }> {
  // The items a decision names: its own, its decision items and its duplicate group's.
  const named = (cond: (eb: kx.AnyEb) => Expression<SqlBool>): Promise<Refs> => db.all(
    db.k.selectFrom("main.decisions as d").select(["d.repo", "d.number"]).where("d.number", "is not", null).$narrowType<{ number: number }>().where(cond)
      .union(db.k.selectFrom("main.decision_items as di").innerJoin("main.decisions as d", "d.id", "di.decision_id").select(["di.repo", "di.number"]).where(cond))
      .union(db.k.selectFrom("main.dupe_group_items as g").innerJoin("main.decisions as d", "d.id", "g.decision_id").select(["g.repo", "g.number"]).where(cond)));
  const open = (eb: kx.AnyEb): Expression<SqlBool> => eb("d.answer", "is", null);
  const unapplied = (eb: kx.AnyEb): Expression<SqlBool> => eb.and([eb("d.answer", "is not", null), eb("d.applied_at", "is", null), eb("d.exec_state", "is distinct from", "disputed")]);
  const disputed = (eb: kx.AnyEb): Expression<SqlBool> => eb.and([eb("d.answer", "is not", null), eb("d.exec_state", "=", "disputed")]);
  const question = await keySet(named(open));
  const answered = await keySet(named(unapplied));
  const dispute = await keySet(named(disputed));
  const stopped = await keySet(db.all(
    db.k.selectFrom("main.actions as a").innerJoin("main.decisions as d", "d.id", "a.decision_id").select(["a.repo", "a.number"])
      .where("a.state", "=", "stopped").where(unapplied)
      .union(db.k.selectFrom("main.item_plans").select(["repo", "number"]).where("kind", "=", "issue")
        .where("wait", "in", [fixStoppedWait("skipped"), fixStoppedWait("failed")]))));
  return { question, answered, dispute, stopped };
}

export async function computeLiveness(db: Db, nowMs: number = Date.now()): Promise<Liveness> {
  const days = Number(await setting(db, LONG_DAYS_KEY));
  const longMs = (Number.isFinite(days) && days > 0 ? days : LONG_DAYS_DEFAULT) * DAY_MS;
  const flags = await flagSets(db);
  // The view's status and wait kind and the action count, read in SQL: the rows' JSON stays in the database. Ended and switched-off items are not checked.
  const phase = (eb: kx.AnyEb) => eb.fn.coalesce(kx.jsonText(db, "p.view", "$.status.phase"), eb.val("Triage"));
  const rows = await db.all(db.k.selectFrom("main.item_plans as p").innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "p.repo").onRef("i.number", "=", "p.number"))
    .select((eb) => ["p.repo", "p.number", "p.kind", "p.state", "p.item_state", kx.jsonArrayLength(db, "p.actions").as("actions"), "p.wait",
      phase(eb).as("phase"), eb.fn.coalesce(kx.jsonText(db, "p.view", "$.status.since"), "p.planned_at").as("since"), kx.jsonText(db, "p.view", "$.waitKind").as("wait_kind")])
    .where("i.state", "=", "OPEN").where((eb) => eb(phase(eb), "not in", ["Pipeline off", "Merged", "Closed"]))
    .$narrowType<{ kind: "pr" | "issue"; actions: number; phase: string; since: string; wait_kind: WaitKind | null }>());
  const items: LivenessItem[] = [];
  const causes: Record<string, number> = {};
  const open = rows.length;
  for (const r of rows) {
    const { phase, since } = r;
    const key = `${r.repo}#${r.number}`;
    // A review held by other items waits on the questions about those items.
    const asked = flags.question.has(key) || blockersOfWait(r.wait).some((b) => flags.question.has(b));
    const verdict = classify(
      { kind: r.kind, state: r.state, itemState: r.item_state, phase, wait: r.wait, waitKind: r.wait_kind, actions: r.actions, since },
      { question: asked, answered: flags.answered.has(key), dispute: flags.dispute.has(key), stopped: flags.stopped.has(key) },
    );
    const base = { repo: r.repo, number: r.number, kind: r.kind, state: r.state, wait: r.wait, phase, since };
    if (!verdict.live) {
      items.push({ ...base, verdict: "stuck", cause: verdict.cause });
      causes[verdict.cause] = (causes[verdict.cause] ?? 0) + 1;
    } else if (verdict.cause !== "parked" && verdict.cause !== "question" && verdict.cause !== "dispute" && verdict.cause !== "stopped"
      // An issue waiting on an open PR does not age on its own: the PR carries the age and is counted itself.
      && !(r.kind === "issue" && isOpenPrWait(r.wait)) && !asked && nowMs - Date.parse(since) > longMs) {
      items.push({ ...base, verdict: "long", cause: verdict.cause });
    }
  }
  items.sort((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === "stuck" ? -1 : 1) || a.since.localeCompare(b.since) || a.repo.localeCompare(b.repo) || a.number - b.number);
  return { checkedAt: new Date(nowMs).toISOString(), stuck: items.filter((i) => i.verdict === "stuck").length, long: items.filter((i) => i.verdict === "long").length, open, causes, items };
}

/** Recomputes and stores the result unless one is newer than REFRESH_MS. Returns true when it ran. */
export async function refreshLiveness(db: Db, nowMs: number = Date.now(), force = false): Promise<boolean> {
  const last = Date.parse(await setting(db, "liveness_at") ?? "");
  if (!force && Number.isFinite(last) && nowMs - last < REFRESH_MS) return false;
  const res = await computeLiveness(db, nowMs);
  await db.write(async () => {
    await db.run(db.k.deleteFrom("main.liveness_items"));
    // Rows per insert: well under the bound-parameter limits of both engines at ten columns a row.
    for (let at = 0; at < res.items.length; at += 1000) {
      await db.run(db.k.insertInto("main.liveness_items").values(res.items.slice(at, at + 1000).map((i) => ({ repo: i.repo, number: i.number, kind: i.kind, verdict: i.verdict, cause: i.cause, state: i.state, wait: i.wait, phase: i.phase, since: i.since, checked_at: res.checkedAt }))));
    }
    await writeSetting(db, "liveness_at", res.checkedAt);
    await writeSetting(db, "liveness_open", String(res.open));
  });
  return true;
}

/** The stored result; null before the first refresh. */
export async function storedLiveness(db: Db): Promise<Liveness | null> {
  const [at, items, openSetting] = await Promise.all([setting(db, "liveness_at"), db.all(db.k.selectFrom("main.liveness_items").select(["repo", "number", "kind", "verdict", "cause", "state", "wait", "phase", "since"])
    .orderBy("verdict", "desc").orderBy("since").orderBy("repo").orderBy("number")
    .$narrowType<{ kind: "pr" | "issue"; verdict: LivenessVerdict }>()), setting(db, "liveness_open")]);
  if (!at) return null;
  const causes: Record<string, number> = {};
  for (const i of items) if (i.verdict === "stuck") causes[i.cause] = (causes[i.cause] ?? 0) + 1;
  const open = Number(openSetting ?? 0);
  return { checkedAt: at, stuck: items.filter((i) => i.verdict === "stuck").length, long: items.filter((i) => i.verdict === "long").length, open, causes, items };
}

export function printReport(l: Liveness): void {
  console.log(`liveness: ${l.open} open items checked, ${l.stuck} stuck, ${l.long} long`);
  for (const [c, n] of Object.entries(l.causes).sort()) console.log(`  stuck by cause: ${c} ${n}`);
  for (const i of l.items) console.log(`${i.verdict.padEnd(5)} ${i.repo}#${i.number} ${i.state} | wait: ${i.wait ?? "-"} | ${i.cause} | since ${i.since.slice(0, 16)}`);
}

export const commands = {
  liveness: {
    summary: "liveness [--json]: open items that are stuck (nothing due, nobody asked) or long; exit 1 when any is stuck",
    run: async (args: string[]) => {
      const { connect } = await import("./db.ts");
      const l = await computeLiveness(await openDb());
      if (args.includes("--json")) console.log(JSON.stringify(l, null, 2));
      else printReport(l);
      process.exit(l.stuck > 0 ? 1 : 0);
    },
  },
};
