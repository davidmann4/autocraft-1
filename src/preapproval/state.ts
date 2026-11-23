// What the planner and the fix-up step read of operator fix-ups and pre-approved merges. No writes here.
import { PERM_READ_TTL } from "../dash/server/sessions.ts";
import { settlesCheckedAtExpr, settlesLoginExpr } from "../settlers.ts";
import { FIXUP_MAX_ATTEMPTS } from "../core/rules.ts";
import * as kx from "../db/kx.ts";
import type { Db } from "../db/index.ts";

/** Fix-up states that count as a try; a row left in `pushing` by a crash counts too. */
const TRY_STATES = ["pushing", "pushed", "failed", "refused", "rejected"];
/** Fix-up states that end the work of an operator fix-up (`linting` is a stored patch waiting for its lint task; `superseded` is one the plan dropped). */
const ENDED_STATES = ["pushing", "pushed", "failed", "refused", "rejected", "cannot-push", "too-large", "push-denied", "asked", "comment-failed", "superseded"];
/** A request counts only while the person who made it still settles on the repo (an operator, or a maintainer under src/settlers.ts): its push is made as them. */
const bySettles = (eb: kx.AnyEb, nowMs: number) => settlesLoginExpr(eb, "o.by", "o.repo", nowMs);
const ended = (eb: kx.AnyEb) => eb.exists(kx.schemaEb(eb).selectFrom("fixups as f").select(eb.lit(1).as("one")).where("f.operator_fix", "=", eb.ref("o.id")).where("f.source", "=", "operator").where("f.state", "in", ENDED_STATES));

/** Tries the operator's fix-ups used on the PR; the fix-up limit of the PR applies to them as to the review's. */
export async function operatorTries(db: Db, repo: string, number: number): Promise<number> {
  return (await db.get(db.k.selectFrom("fixups").select((eb) => eb.fn.countAll<number>().as("n"))
    .where("repo", "=", repo).where("number", "=", number).where("source", "=", "operator").where("state", "in", TRY_STATES)))!.n;
}
export const operatorTriesLeft = async (db: Db, repo: string, number: number): Promise<boolean> => await operatorTries(db, repo, number) < FIXUP_MAX_ATTEMPTS;

export type OperatorFix = { id: number; head: string; instructions: string; by: string; preapprovalId: number | null };

/** The operator fix-up of the PR still to work at `head`: queued and without a final fixups row of its own (matched by the request's id). */
export async function queuedOperatorFix(db: Db, repo: string, number: number, head: string, nowMs: number = Date.now()): Promise<OperatorFix | null> {
  const r = await db.get(db.k.selectFrom("operator_fixups as o").select(["o.id", "o.from_head", "o.instructions", "o.by", "o.preapproval_id"])
    .where("o.repo", "=", repo).where("o.number", "=", number).where("o.from_head", "=", head).where("o.state", "=", "queued")
    .where((eb) => bySettles(eb, nowMs)).where((eb) => eb.not(ended(eb)))
    .orderBy("o.id", "desc").limit(1));
  return r ? { id: r.id, head: r.from_head, instructions: r.instructions, by: r.by, preapprovalId: r.preapproval_id } : null;
}

export type OperatorWork = {
  fixHeads: Set<string>; hold: boolean; /** The pushed head of a pre-approved merge waiting for its pre-merge review (state `ci`). */ premergeHeads: Set<string>; /** A pre-approved merge is live (fixup, review, ci or queued). */ preapproved: boolean;
  /** The live pre-approved merge was queued with bypass checks. */ bypass?: boolean;
  /** When the first of `fixHeads`' requests stops counting with the clock alone: its maintainer's cached write permission ages out (ms). */
  settleUntil?: number;
};

/** Per PR ("repo#n") at `nowMs`: the heads with an operator fix-up still to work, whether a pre-approved merge is before its merge answer or live at all, and the heads due a pre-merge review. Small tables, read once per pass. */
export async function operatorWork(db: Db, repo?: string, nowMs: number = Date.now()): Promise<Map<string, OperatorWork>> {
  const out = new Map<string, OperatorWork>();
  const get = (r: string, n: number): OperatorWork => {
    const k = `${r}#${n}`;
    let w = out.get(k);
    if (!w) out.set(k, (w = { fixHeads: new Set(), hold: false, premergeHeads: new Set(), preapproved: false }));
    return w;
  };
  for (const o of await db.all(db.k.selectFrom("operator_fixups as o")
    .select((eb) => ["o.repo", "o.number", "o.from_head", settlesCheckedAtExpr(eb, "o.by", "o.repo").as("checked_at")])
    .where("o.state", "=", "queued").where((eb) => bySettles(eb, nowMs)).where((eb) => eb.not(ended(eb)))
    .$if(!!repo, (q) => q.where("o.repo", "=", repo!)))) {
    const w = get(o.repo, o.number);
    w.fixHeads.add(o.from_head);
    if (o.checked_at) { const until = Date.parse(o.checked_at) + PERM_READ_TTL; if (!(w.settleUntil! <= until)) w.settleUntil = until; }
  }
  for (const p of await db.all(db.k.selectFrom("preapprovals").select(["repo", "number", "state", "head", "bypass"]).where("state", "in", ["fixup", "review", "ci", "queued"])
    .$if(!!repo, (q) => q.where("repo", "=", repo!)))) {
    const w = get(p.repo, p.number);
    w.preapproved = true;
    if (p.bypass) w.bypass = true;
    if (p.state === "queued") continue;
    w.hold = true;
    if (p.state === "ci" && p.head) w.premergeHeads.add(p.head);
  }
  return out;
}

export type OpenRequest = { id: number; repo: string; number: number; head: string; preapprovalId: number | null; started: boolean };

/** Every operator fix-up request still queued (no final fixups row of its own); `started` when a fixups row of it exists (a stored patch or a push under way). */
export async function openOperatorFixups(db: Db, nowMs: number = Date.now()): Promise<OpenRequest[]> {
  const rows = await db.all(db.k.selectFrom("operator_fixups as o")
    .select((eb) => ["o.id", "o.repo", "o.number", "o.from_head", "o.preapproval_id",
      eb.exists(eb.selectFrom("fixups as f").select(eb.lit(1).as("one")).whereRef("f.operator_fix", "=", "o.id")).as("started")])
    .where("o.state", "=", "queued").where((eb) => bySettles(eb, nowMs)).where((eb) => eb.not(ended(eb)))
    .where("o.repo", "in", (eb) => eb.selectFrom("main.tracked_repos").select("name"))
    .orderBy("o.repo").orderBy("o.number").orderBy("o.from_head").orderBy("o.id"));
  return rows.map((r) => ({ id: r.id, repo: r.repo, number: r.number, head: r.from_head, preapprovalId: r.preapproval_id, started: !!r.started }));
}
