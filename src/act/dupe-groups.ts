// Act for duplicate group decisions answered "use this answer" or "keep #N instead": post the
// exact comments stored for the chosen option (src/dupes/texts.ts) and close the members it closes.
// Each write is recorded in dupe_group_posts right after it happens, so a retry or a crash
// midway never repeats a comment or a close. A member that closed, merged or moved on its own
// is skipped, and so is a whole decision whose answer or roles changed (undo, refresh) while the run went on.
import { settledByExpr } from "../settlers.ts";
import { audit } from "../dash/audit.ts";
import { embedHash } from "../itemhash.ts";
import { backlogHeld, bypassQueued } from "../dupes/held.ts";
import { inPilot } from "../pilot.ts";
import { textsFor } from "../dupes/texts.ts";
import { compareAgain } from "../dupes/compare.ts";
import { comparedHead } from "../dupes/plan.ts";
import { everySeq, filterSeq, findSeq, someSeq } from "../async-seq.ts";
import * as kx from "../db/kx.ts";
import type { Db } from "../db/index.ts";

const ACTOR = "act";
/** Failed writes on one member before it is recorded as skipped. */
export const MAX_FAILS = 3;

export type GroupLive = { id: string; type: "Issue" | "PullRequest"; state: string; head: string | null };
export type GroupIo = {
  live(number: number): Promise<GroupLive | null>;
  /** Returns the comment's URL. */
  comment(live: GroupLive, body: string, at: { number: number; decision: string }): Promise<string>;
  /** `kept` is the group's kept item (an issue when there is one) the closed member duplicates. */
  close(live: GroupLive, at: { number: number; decision: string }, kept?: GroupLive & { number: number }): Promise<void>;
  /** Called before a decision's writes: a string says why the decision waits (its operator has no token or no access), and it is left for a later run. */
  begin?(decision: string): Promise<string | null>;
  /** A write of the decision failed with `why` (the error `err`); true when that is a wait for the operator's access or a transient failure, not a failure to count. */
  failed?(decision: string, why: string, err: unknown): Promise<boolean>;
};
export type GroupRun = {
  repo: string; io: GroupIo; at: () => string; log: (line: string) => void;
  /** Writes this run may still do under the step's limit. */
  left: () => number;
  handled: () => void;
  dryRun: boolean;
};
export type GroupResult = { done: string[]; skipped: { ref: string; reason: string }[]; failed: { ref: string; reason: string }[] };

type Item = { number: number; kind: string; role: string; detail: string | null; head: string | null };
type Decision = { id: string; answer: string };

/** Answered group decisions of the repo whose roles are written (applyDuplicateAnswers ran) and that are not applied yet. */
export async function groupDecisionsToAct(db: Db, repo: string): Promise<Decision[]> {
  return await db.all(db.k.selectFrom("decisions as d").innerJoin("dupe_groups as g", "g.decision_id", "d.id")
    .select(["d.id", "d.answer"]).$narrowType<{ answer: string }>()
    .where("d.kind", "=", "duplicate").where("d.repo", "=", repo).where("d.answer", "is not", null).where("d.answer", "not in", ["distinct", "backlog"]).where("d.applied_at", "is", null)
    .whereRef("g.applied_answer", "=", "d.answer").where((eb) => settledByExpr(db, eb, "d"))
    .orderBy("d.answered_at", (o) => o.asc().nullsFirst()));
}

/** Members the act step still has to close, over all repos: close-role members of the decisions above (as actOnGroups selects its closers) with no close record yet. The planner lists an act action for each. */
export async function groupClosersPending(db: Db): Promise<{ decisionId: string; repo: string; number: number }[]> {
  const rows = await db.all(db.k.selectFrom("decisions as d").innerJoin("dupe_groups as g", "g.decision_id", "d.id").innerJoin("dupe_group_items as gi", "gi.decision_id", "d.id")
    .select(["d.id", "d.repo", "gi.number"]).$narrowType<{ repo: string }>()
    .where("d.kind", "=", "duplicate").where("d.repo", "is not", null).where((eb) => kx.like(db, "d.id", eb.val("%:dupegroup:%")))
    .where("d.answer", "is not", null).where("d.answer", "not in", ["distinct", "backlog"]).where("d.applied_at", "is", null)
    .whereRef("g.applied_answer", "=", "d.answer").where((eb) => settledByExpr(db, eb, "d")).where("gi.role", "=", "close")
    .where((eb) => eb.not(eb.exists(eb.selectFrom("dupe_group_posts as p").select(eb.lit(1).as("one"))
      .whereRef("p.decision_id", "=", "d.id").whereRef("p.number", "=", "gi.number").where("p.step", "=", "close"))))
    .orderBy("d.answered_at", (o) => o.asc().nullsFirst()).orderBy("gi.number"));
  return (await filterSeq(rows, async (r) => await inPilot(db, r.repo, r.number) && !await backlogHeld(db, r.repo, r.number))).map((r) => ({ decisionId: r.id, repo: r.repo, number: r.number }));
}

/** The decision's answer and the item's stored role are still what the run started from: an undo or a refresh in between changes them. */
async function unchanged(db: Db, dec: Decision, item: Item): Promise<boolean> {
  return !!await db.get(db.k.selectFrom("decisions as d").innerJoin("dupe_groups as g", "g.decision_id", "d.id").innerJoin("dupe_group_items as gi", "gi.decision_id", "d.id")
    .select((eb) => eb.lit(1).as("one"))
    .where("d.id", "=", dec.id).where("d.answer", "=", dec.answer).where("d.applied_at", "is", null).where("g.applied_answer", "=", dec.answer)
    .where("gi.number", "=", item.number).where("gi.role", "=", item.role));
}

const carryOf = (detail: string | null): string[] => {
  try {
    const v = (JSON.parse(detail ?? "null") as { carry?: unknown } | null)?.carry;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
};

export async function actOnGroups(db: Db, run: GroupRun): Promise<GroupResult> {
  const res: GroupResult = { done: [], skipped: [], failed: [] };
  const posted = async (id: string, n: number, step: string): Promise<boolean> =>
    !!await db.get(db.k.selectFrom("dupe_group_posts").select((eb) => eb.lit(1).as("one")).where("decision_id", "=", id).where("number", "=", n).where("step", "=", step));
  const record = async (id: string, n: number, step: string, url: string | null) =>
    await db.run(db.k.insertInto("dupe_group_posts").values({ decision_id: id, number: n, step, url, at: run.at() }).onConflict((oc) => oc.doNothing()));
  const ref = (n: number) => `${run.repo}#${n}`;

  // An item queued with bypass checks after the answer is never closed by it: it is released below (the planner keeps it open the same way, src/dupes/decide.ts).
  const bypass = await bypassQueued(db, run.repo);

  decisions: for (const dec of await groupDecisionsToAct(db, run.repo)) {
    const items: Item[] = await db.all(db.k.selectFrom("dupe_group_items").select(["number", "kind", "role", "detail", "head"]).where("decision_id", "=", dec.id).orderBy("number"));
    const texts = new Map((await textsFor(db, dec.id, dec.answer)).map((t) => [`${t.number}:${t.step}`, t.text]));
    const closers = await filterSeq(items, async (i) => i.role === "close" && await inPilot(db, run.repo, i.number) && !await backlogHeld(db, run.repo, i.number));
    const details = await findSeq(items, async (i) => i.role === "keep" && i.kind === "issue" && texts.has(`${i.number}:details`) && await inPilot(db, run.repo, i.number));
    if (run.dryRun) {
      if (details && !await posted(dec.id, details.number, "details")) run.log(`  would post the details comment on ${ref(details.number)} (${dec.id})`);
      for (const c of closers) if (!await posted(dec.id, c.number, "close")) run.log(bypass.has(ref(c.number)) ? `  would release ${ref(c.number)}, queued with bypass checks (${dec.id})` : `  would comment and close ${ref(c.number)} (${dec.id})`);
      continue;
    }
    // A PR is closed or kept only at a head a stored comparison read: with none that recorded heads, the set is compared first
    // (compareAgain marks a stored row; a set with no row is due anyway). A PR with no head is released below instead.
    const unbound = await filterSeq(items, async (i) => i.kind === "pr" && i.role !== "stay" && !!i.head && !await posted(dec.id, i.number, "close") && await comparedHead(db, run.repo, i.number) === undefined);
    if (unbound.length) {
      for (const i of unbound) await compareAgain(db, ACTOR, run.repo, i.number);
      run.log(`  ${dec.id}: waits for a comparison that records the heads of ${unbound.map((i) => ref(i.number)).join(", ")}`);
      continue;
    }
    const waits = await run.io.begin?.(dec.id);
    if (waits) { run.log(`  ${dec.id}: waiting: ${waits}`); continue; }
    const skip = async (n: number, step: string, reason: string, release = false) => {
      await record(dec.id, n, step, null);
      if (release) {
        // Not closed by this decision: it stays open, is no longer held or settled by it, and the next comparison may ask about it again.
        await db.run(db.k.updateTable("dupe_group_items").set({ role: "stay", target: null, base_role: "stay", base_target: null }).where("decision_id", "=", dec.id).where("number", "=", n));
        await record(dec.id, n, "released", null);
        await audit(db, ACTOR, "duplicate-member-released", ref(n), { decision: dec.id, reason });
      }
      await audit(db, ACTOR, "act-skip", ref(n), { decision: dec.id, reason });
      res.skipped.push({ ref: ref(n), reason });
      run.log(`  ${ref(n)}: skipped: ${reason}`);
    };
    const changed = async (it: Item): Promise<boolean> => {
      if (await unchanged(db, dec, it)) return false;
      run.log(`  ${dec.id}: changed since the run started; left for the next run`);
      return true;
    };
    let cur: { item: Item; step: string } | null = null;
    try {
      if (await someSeq(closers, async (c) => !await posted(dec.id, c.number, "close")) || (details && !await posted(dec.id, details.number, "details"))) {
        // The kept items must still stand: a closed (unmerged) kept item makes the duplicates' comments wrong.
        for (const k of items.filter((i) => i.role === "keep")) {
          const live = await run.io.live(k.number);
          const gone = !live || (live.state !== "OPEN" && !(live.type === "PullRequest" && live.state === "MERGED"));
          // An open kept PR at another head than the comparison read is no longer the code the duplicates were closed for.
          const bound = k.kind === "pr" ? await comparedHead(db, run.repo, k.number) : undefined;
          // A kept PR with no known head is no code a comparison saw: the decision ends, and comparing again would not tell more.
          const unknown = !gone && k.kind === "pr" && live!.state === "OPEN" && (!k.head || !bound);
          const moved = !gone && !unknown && k.kind === "pr" && live!.state === "OPEN" && (live!.head !== k.head || bound !== k.head);
          if (gone || unknown || moved) {
            // Nothing stays held by a decision that can no longer close anything: the members are released and the next comparison asks again.
            const reason = moved ? `the head of the kept PR ${ref(k.number)} moved since the comparison` : unknown ? `no comparison read a head of the kept PR ${ref(k.number)}` : `the kept item ${ref(k.number)} is gone or closed`;
            for (const c of closers) if (!await posted(dec.id, c.number, "close")) await skip(c.number, "close", reason, true);
            // The next comparison reads the kept PR's new head.
            if (moved) await compareAgain(db, ACTOR, run.repo, k.number);
            await db.run(db.k.updateTable("main.decisions").set({ applied_at: run.at() }).where("id", "=", dec.id).where("applied_at", "is", null));
            await audit(db, ACTOR, "duplicate-group-ended", dec.id, { reason });
            run.log(`  ${dec.id}: ${reason}; group ended`);
            continue decisions;
          }
        }
      }
      if (details && !await posted(dec.id, details.number, "details")) {
        if (run.left() <= 0) return res;
        cur = { item: details, step: "details" };
        if (await changed(details)) continue decisions;
        const live = await run.io.live(details.number);
        if (!live || live.state !== "OPEN") await skip(details.number, "details", "the kept issue is gone or closed; no details comment");
        else {
          if (await changed(details)) continue decisions;
          const text = texts.get(`${details.number}:details`)!;
          const url = await run.io.comment(live, text, { number: details.number, decision: dec.id });
          await record(dec.id, details.number, "details", url);
          run.handled();
          run.log(`  ${ref(details.number)}: posted the details comment`);
        }
      }
      for (const c of closers) {
        if (await posted(dec.id, c.number, "close")) continue;
        if (run.left() <= 0) return res;
        cur = { item: c, step: "close" };
        if (await changed(c)) continue decisions;
        if (bypass.has(ref(c.number))) { await skip(c.number, "close", "it was queued with bypass checks", true); continue; }
        const live = await run.io.live(c.number);
        if (!live) { await skip(c.number, "close", "GitHub returned no such item"); continue; }
        if (live.state !== "OPEN") { await skip(c.number, "close", `already ${live.state.toLowerCase()} on GitHub`); continue; }
        if (c.kind === "pr") {
          const bound = await comparedHead(db, run.repo, c.number);
          // No head known: released without comparing again, which would read no head either.
          if (!c.head || !bound) { await skip(c.number, "close", "no comparison read a head of it", true); continue; }
          if (live.head !== c.head || bound !== c.head) { await skip(c.number, "close", "the head moved since the comparison", true); await compareAgain(db, ACTOR, run.repo, c.number); continue; }
        }
        if (c.kind === "issue" && c.head) {
          const row = await db.get(db.k.selectFrom("items").select(["embed_hash", "title", "body"]).where("repo", "=", run.repo).where("number", "=", c.number));
          // A missing stored hash is computed from the text; an item without a row counts as changed.
          const now = row ? (row.embed_hash ?? embedHash(row.title, row.body)) : null;
          if (now !== c.head) { await skip(c.number, "close", "the text changed since the comparison", true); continue; }
        }
        const text = texts.get(`${c.number}:close`);
        if (!text) { await skip(c.number, "close", "the decision stores no comment for this answer"); continue; }
        let url = (await db.get(db.k.selectFrom("dupe_group_posts").select("url").where("decision_id", "=", dec.id).where("number", "=", c.number).where("step", "=", "comment")))?.url ?? null;
        if (url === null) {
          if (await changed(c)) continue decisions;
          url = await run.io.comment(live, text, { number: c.number, decision: dec.id });
          await record(dec.id, c.number, "comment", url);
        }
        if (await changed(c)) continue decisions;
        const keep = items.find((i) => i.role === "keep" && i.kind === "issue") ?? items.find((i) => i.role === "keep");
        const keptLive = keep ? await run.io.live(keep.number) : null;
        await run.io.close(live, { number: c.number, decision: dec.id }, keep && keptLive ? { ...keptLive, number: keep.number } : undefined);
        await record(dec.id, c.number, "close", url);
        await db.run(db.k.insertInto("main.stages").values({ repo: run.repo, number: c.number, stage: "closed", at: run.at(), actor: ACTOR, note: `closed after duplicate group decision ${dec.id}` }));
        res.done.push(ref(c.number));
        run.handled();
        run.log(`  ${ref(c.number)}: commented and closed`);
      }
    } catch (e) {
      const why = (e as Error).message.replace(/\s+/g, " ").slice(0, 300);
      if (await run.io.failed?.(dec.id, why, e)) { run.log(`  ${dec.id}: waiting: ${why}`); continue; }
      res.failed.push({ ref: cur ? ref(cur.item.number) : dec.id, reason: why });
      run.log(`  ${dec.id}: failed: ${why}`);
      if (!cur) return res;
      // One permanent error (a locked issue, a 403) must not block every later group: after MAX_FAILS the member is skipped.
      await db.run(db.k.insertInto("dupe_group_fails").values({ decision_id: dec.id, number: cur.item.number, fails: 1 })
        .onConflict((oc) => oc.columns(["decision_id", "number"]).doUpdateSet((eb) => ({ fails: eb("dupe_group_fails.fails", "+", 1) }))));
      const n = (await db.get(db.k.selectFrom("dupe_group_fails").select("fails").where("decision_id", "=", dec.id).where("number", "=", cur.item.number)))!.fails;
      if (n < MAX_FAILS) return res;
      // A member whose comment is already public is settled, not released: re-asking would repeat the comment.
      const commented = !!await db.get(db.k.selectFrom("dupe_group_posts").select((eb) => eb.lit(1).as("one")).where("decision_id", "=", dec.id).where("number", "=", cur.item.number).where("step", "=", "comment").where("url", "is not", null));
      await skip(cur.item.number, cur.step, `${n} writes failed: ${why}`, cur.step === "close" && !commented);
    }
    // Applied once every member to close has a close record and the details comment is settled.
    if (await everySeq(closers, async (c) => await posted(dec.id, c.number, "close")) && (!details || await posted(dec.id, details.number, "details"))) {
      await db.run(db.k.updateTable("main.decisions").set({ applied_at: run.at() }).where("id", "=", dec.id).where("applied_at", "is", null));
      await audit(db, ACTOR, "act-group-applied", dec.id, { answer: dec.answer });
      await queueCarry(db, run.repo, dec.id, items, run.at());
    }
  }
  return res;
}

/** The kept PR gets a carry job when the PRs closed in its group name parts worth carrying over. */
async function queueCarry(db: Db, repo: string, id: string, items: Item[], at: string): Promise<void> {
  const keep = items.find((i) => i.role === "keep" && i.kind === "pr");
  if (!keep || !await someSeq(items, async (i) => i.kind === "pr" && i.role === "close" && carryOf(i.detail).length && await db.get(db.k.selectFrom("dupe_group_posts").select((eb) => eb.lit(1).as("one")).where("decision_id", "=", id).where("number", "=", i.number).where("step", "=", "close").where("url", "is not", null)))) return;
  await db.run(db.k.insertInto("dupe_carries").values({ decision_id: id, repo, number: keep.number, state: "queued", updated_at: at }).onConflict((oc) => oc.doNothing()));
  await audit(db, ACTOR, "carry-queued", `${repo}#${keep.number}`, { decision: id });
}
