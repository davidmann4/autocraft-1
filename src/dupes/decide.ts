// Duplicate group decisions. A group (plan.ts) with a current comparison (compare.ts)
// gets one decision: keep the compared best item, close the others as duplicates,
// carry over what they do better. The decision's number is the kept item (the kept
// PR when the group has one); its members and their roles are in dupe_group_items,
// which the later stages read to hold the items to close. Per-pair decisions from
// before groups exist stay until answered; an open one of a group is superseded
// by the group decision.
import { settledByExpr } from "../settlers.ts";
import { jobItem } from "../runner/job-items.ts";
import { audit } from "../dash/audit.ts";
import { actionable, ask, factsOf, getDecision, validateAsk } from "../decisions.ts";
import { compareCanonical, canonInfo } from "./canonical.ts";
import { DUP_FACT, GROUP_OPTIONS, groupId, keepKey, keptOf } from "./held.ts";
import { duplicateGroups, kindSetsLoader, currentComparison, storedComparisons, type Group, type KindSet, type StoredComparison } from "./plan.ts";
import { oneSentence } from "../review/summary.ts";
import { storeOptionTexts } from "./texts.ts";
import { inPilot, pilotExprFor } from "../pilot.ts";
import { withdrawGroupedQuestions } from "../merge/withdraw.ts";
import { filterSeq, mapSeq, someSeq } from "../async-seq.ts";
import * as kx from "../db/kx.ts";
import type { Db } from "../db/index.ts";

export { duplicateEdges, duplicateGroups, type Group } from "./plan.ts";

const ACTOR = "dupes";

export const decisionId = (repo: string, x: number, y: number): string => `${repo}#${x}:duplicate@${y}`;

const clip = (s: string | null, n = 110): string => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

type Role = "keep" | "close" | "stay";
export type PlanItem = { number: number; kind: "pr" | "issue"; role: Role; target: number | null; detail: Record<string, unknown> | null };
export type GroupPlan = {
  repo: string; group: Group; baseId: string; number: number; items: PlanItem[];
  closing: boolean; source: "model" | "closed" | "rule"; model: string | null; reasons: string[];
  sets: { set: KindSet; cmp: StoredComparison }[];
};

const list = (ns: number[]) => ns.map((n) => `#${n}`).join(", ");

const answeredGroup = (eb: kx.AnyEb) => eb.and([eb("d.kind", "=", "duplicate"), eb("d.answer", "is not", null), eb("d.answer", "not in", ["superseded", "distinct", "backlog"])]);
type Answered = { settled: Set<number>; keep: Map<string, number> };

/**
 * For each group: the earlier answered group decisions of its members (oldest asked first) settle the members they list and
 * their keep stays kept. The decisions and their members, without the released ones, are read once for all groups.
 */
async function answeredKeepsLoader(db: Db, repo?: string): Promise<(repo: string, members: number[]) => Answered> {
  const byMember = new Map<string, { id: string; asked_at: string | null }[]>();
  for (const r of await db.all(db.k.selectFrom("decisions as d").innerJoin("dupe_group_items as gi", "gi.decision_id", "d.id")
    .select(["d.id", "d.asked_at", "gi.repo", "gi.number"]).distinct()
    .where(answeredGroup).$if(repo !== undefined, (q) => q.where("gi.repo", "=", repo!)))) {
    const k = `${r.repo}#${r.number}`;
    (byMember.get(k) ?? byMember.set(k, []).get(k)!).push({ id: r.id, asked_at: r.asked_at });
  }
  // Each decision's members in its primary key order (number), as a read by decision id gives them.
  const members = new Map<string, { number: number; kind: string; role: string }[]>();
  for (const r of await db.all(db.k.selectFrom("dupe_group_items as gi").innerJoin("decisions as d", "d.id", "gi.decision_id")
    .select(["gi.decision_id", "gi.number", "gi.kind", "gi.role"])
    .where(answeredGroup)
    .where((eb) => eb.not(eb.exists(eb.selectFrom("dupe_group_posts as p").select(eb.lit(1).as("one"))
      .whereRef("p.decision_id", "=", "gi.decision_id").whereRef("p.number", "=", "gi.number").where("p.step", "=", "released"))))
    .orderBy("gi.decision_id").orderBy("gi.number")))
    (members.get(r.decision_id) ?? members.set(r.decision_id, []).get(r.decision_id)!).push(r);
  // ORDER BY asked_at, id: NULL first, then byte order.
  const before = (a: string | null, b: string | null): number => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1);
  return (r, ns) => {
    const ids = new Map<string, string | null>();
    for (const n of ns) for (const d of byMember.get(`${r}#${n}`) ?? []) ids.set(d.id, d.asked_at);
    const settled = new Set<number>(), keep = new Map<string, number>();
    for (const [id] of [...ids].sort((a, b) => before(a[1], b[1]) || before(a[0], b[0])))
      for (const m of members.get(id) ?? []) {
        settled.add(m.number);
        if (m.role === "keep") keep.set(m.kind, m.number);
      }
    return { settled, keep };
  };
}

/** The items fast-tracked with bypass checks (src/fasttrack.ts) as `repo#number`, of one repo or every repo. */
async function fastTracked(db: Db, repo?: string): Promise<Set<string>> {
  const rows = await db.all(db.k.selectFrom("fast_track").select(["repo", "number"]).where("bypass", "=", 1).$if(!!repo, (q) => q.where("repo", "=", repo!)));
  return new Set(rows.map((r) => `${r.repo}#${r.number}`));
}

/** Plans for the groups whose comparisons are all current. `closing` is false for a group with nothing to close. */
export async function groupPlans(db: Db, repo?: string): Promise<GroupPlan[]> {
  const out: GroupPlan[] = [];
  const groups = await duplicateGroups(db, repo), setsOf = await kindSetsLoader(db, groups), stored = await storedComparisons(db, repo), answeredKeeps = await answeredKeepsLoader(db, repo);
  // An item queued with bypass checks is wanted as it is: it is never closed as a duplicate, so it and the item kept stay open and are both worked.
  const fast = await fastTracked(db, repo);
  for (const g of groups) {
    const sets = await filterSeq(setsOf(g), async (s) => await someSeq(s.members, async (m) => m.state === "OPEN" && await setsOf.inPilot(s.repo, m.number)));
    if (!sets.length) continue;
    // A member held by a Backlog answer is not asked about again.
    if (g.members.some((n) => setsOf.backlogHeld(g.repo, n))) continue;
    const ready = await mapSeq(sets, async (set) => ({ set, cmp: await currentComparison(db, set, stored) }));
    if (ready.some((r) => !r.cmp)) continue;
    const full = ready as { set: KindSet; cmp: StoredComparison }[];
    const { settled, keep: fixedKeep } = answeredKeeps(g.repo, g.members);
    const items: PlanItem[] = [];
    for (const { set, cmp } of full) {
      const numbers = set.members.map((m) => m.number);
      // An answered decision's keep stays kept; only members it did not cover are asked against it.
      const fixed = fixedKeep.get(set.kind);
      const kept = fixed !== undefined && numbers.includes(fixed) ? fixed : cmp.kept;
      for (const m of set.members) {
        if (m.number === kept) { items.push({ number: m.number, kind: set.kind, role: "keep", target: null, detail: null }); continue; }
        if (settled.has(m.number)) continue;
        const other = cmp.result?.others.find((o) => o.number === m.number);
        const dup = set.kind === "issue" || other?.duplicate !== false;
        const role: Role = m.state === "OPEN" && dup && !fast.has(`${set.repo}#${m.number}`) && await setsOf.inPilot(set.repo, m.number) ? "close" : "stay";
        items.push({ number: m.number, kind: set.kind, role, target: role === "close" ? kept : null, detail: other ? { ...other } : null });
      }
    }
    // The kept PR is linked to the kept issue.
    const keepPr = items.find((i) => i.role === "keep" && i.kind === "pr"), keepIssue = items.find((i) => i.role === "keep" && i.kind === "issue");
    if (keepPr && keepIssue) keepPr.detail = { ...(keepPr.detail ?? {}), link: keepIssue.number };
    const primary = (keepPr ?? keepIssue)!;
    const sources = full.map((f) => f.cmp.source);
    const fresh = items.filter((i) => !settled.has(i.number)).map((i) => i.number);
    out.push({
      repo: g.repo, group: g, baseId: groupId(g.repo, Math.min(...(fresh.length ? fresh : items.map((i) => i.number)))), number: primary.number, items,
      closing: items.some((i) => i.role === "close"),
      source: sources.includes("rule") ? "rule" : sources.every((s) => s === "closed" || s === "single") ? "closed" : "model",
      model: full.find((f) => f.cmp.model)?.cmp.model ?? null, reasons: full.map((f) => f.cmp.reason).filter((r): r is string => !!r), sets: full,
    });
  }
  return out;
}

/** What Act compares before closing a member: a PR's head commit, an issue's text hash. */
async function headOf(db: Db, repo: string, n: number, kind: string): Promise<string | null> {
  const r = await db.get(db.k.selectFrom("items").select(["head_oid", "embed_hash"]).where("repo", "=", repo).where("number", "=", n));
  return (kind === "pr" ? r?.head_oid : r?.embed_hash) ?? null;
}

/** The head a decision binds a member to: for a PR the head its comparison read (the current one for comparisons stored without heads), so Act never closes, keeps or carries code no comparison saw. */
async function boundHead(db: Db, p: GroupPlan, i: { number: number; kind: string }): Promise<string | null> {
  if (i.kind !== "pr") return await headOf(db, p.repo, i.number, i.kind);
  const cmp = p.sets.find((s) => s.set.kind === "pr" && s.cmp.members.includes(i.number))?.cmp;
  let heads: Record<string, string> = {};
  try { heads = JSON.parse(cmp?.heads ?? "{}") as Record<string, string>; } catch { /* none stored */ }
  return cmp?.heads != null ? heads[i.number] ?? null : await headOf(db, p.repo, i.number, i.kind);
}

async function supersede(db: Db, p: GroupPlan, id: string, at: string): Promise<void> {
  const rows = await db.all(db.k.selectFrom("decisions").select("id").where("kind", "=", "duplicate").where("repo", "=", p.repo).where("answer", "is", null)
    .where("id", "<>", id).where(kx.inList(db, "number", p.group.members, "bigint")));
  const items = await db.all(db.k.selectFrom("decisions as d").innerJoin("dupe_group_items as gi", "gi.decision_id", "d.id").select("d.id").distinct()
    .where("d.kind", "=", "duplicate").where("d.repo", "=", p.repo).where("d.answer", "is", null).where("d.id", "<>", id)
    .where(kx.inList(db, "gi.number", p.group.members, "bigint")));
  for (const r of new Set([...rows, ...items].map((x) => x.id))) {
    await db.run(db.k.updateTable("main.decisions").set({ answer: "superseded", answered_by: ACTOR, answered_at: at, applied_at: at }).where("id", "=", r).where("answer", "is", null));
    await audit(db, ACTOR, "duplicate-superseded", r, { by: id });
  }
}

async function unchanged(db: Db, q: Record<string, unknown>, p: GroupPlan): Promise<boolean> {
  const id = q.id as string;
  const cur = await db.get(db.k.selectFrom("decisions").select(["question", "context", "facts", "options", "recommended", "recommended_reason", "summary", "summary_by", "prepared_at"])
    .where("id", "=", id).where("answer", "is", null));
  if (!cur) return false;
  const next = validateAsk(q);
  // A prepared decision keeps the judgement model's summary and pick.
  const cols: (keyof typeof cur)[] = ["question", "context", "facts", "options", ...(cur.prepared_at ? [] : ["recommended", "recommended_reason", "summary", "summary_by"] as const)];
  if (cols.some((c) => cur[c] !== next[c])) return false;
  const g = await db.get(db.k.selectFrom("dupe_groups").select(["source", "applied_answer"]).where("decision_id", "=", id));
  if (!g || g.source !== p.source || g.applied_answer !== null) return false;
  const rows = await db.all(db.k.selectFrom("dupe_group_items").select(["number", "role", "target", "base_role", "base_target", "detail", "head"]).where("decision_id", "=", id));
  if (rows.some((r) => r.role !== r.base_role || r.target !== r.base_target)) return false;
  const key = (number: number, role: string, target: number | null, detail: string | null, head: string | null) => JSON.stringify([number, role, target, detail, head]);
  const stored = rows.map((r) => key(r.number, r.base_role, r.base_target, r.detail, r.head)).sort();
  const planned = (await mapSeq(p.items, async (i) => key(i.number, i.role, i.target, i.detail ? JSON.stringify(i.detail) : null, await boundHead(db, p, i)))).sort();
  return stored.length === planned.length && stored.every((s, k) => s === planned[k]);
}

/** The open group decision that already lists one of the plan's members, else the first unused id. */
async function idFor(db: Db, p: GroupPlan): Promise<string> {
  const open = await db.get(db.k.selectFrom("decisions as d").innerJoin("dupe_group_items as gi", "gi.decision_id", "d.id").select("d.id")
    .where("d.kind", "=", "duplicate").where("d.answer", "is", null).where((eb) => kx.like(db, "d.id", eb.val("%:dupegroup:%")))
    .where("gi.repo", "=", p.repo).where(kx.inList(db, "gi.number", p.group.members, "bigint")).orderBy("d.id").limit(1));
  if (open) return open.id;
  for (let k = 1; ; k++) {
    const id = k === 1 ? p.baseId : `${p.baseId}~${k}`;
    if (!await getDecision(db, id)) return id;
  }
}

const refList = (ns: number[]) => list(ns);

async function textOf(db: Db, p: GroupPlan) {
  const keeps = p.items.filter((i) => i.role === "keep");
  const closes = p.items.filter((i) => i.role === "close").map((i) => i.number);
  const stays = p.items.filter((i) => i.role === "stay").map((i) => i.number);
  const byRule = p.source === "rule";
  const primary = keeps.find((k) => k.number === p.number)!;
  // The model's own summary, whole. A comparison stored without one gives its reason whole; a rule-picked one says so.
  const used = p.sets.filter((s) => s.cmp.source !== "single").map((s) => s.cmp);
  const kept = (c: StoredComparison) => list(keeps.filter((k) => k.kind === c.kind).map((k) => k.number));
  const texts = used.map((c) => c.summary
    || (c.source === "rule" ? `Kept ${kept(c)} by rule: ${(c.reason ?? "").replace(/^kept by rule: /, "")}.` : c.source === "closed" ? `Kept ${kept(c)}: ${c.reason ?? ""}.` : c.reason ?? "")).filter(Boolean);
  const summary = texts.join(" ") || `Keep ${list(keeps.map((k) => k.number))}.`;
  const by = used.length && used.every((c) => c.source === "model") ? p.model ?? "" : "";
  // One sentence for the recommendation; none from a rule or when the model gave nothing to say.
  const lead = p.sets.find((s) => s.cmp.kept === primary.number) ?? p.sets[0]!;
  const why = byRule || lead.cmp.source === "single" ? null : oneSentence(lead.cmp.why) ?? oneSentence(lead.cmp.reason);
  const keepFacts = await mapSeq(keeps, async (k) => {
    const r = (await db.get(db.k.selectFrom("items").select(["kind", "state", "title", "comments_count"]).where("repo", "=", p.repo).where("number", "=", k.number)))!;
    return `Keep: #${k.number} (${r.kind === "pr" ? "PR" : "issue"}, ${r.state === "OPEN" ? "open" : r.state === "MERGED" ? "merged" : "closed"}, ${r.comments_count ?? 0} comments): ${clip(r.title)}`;
  });
  const chosen = byRule ? `Chosen by: rule (${p.reasons.map((r) => r.replace(/^kept by rule: /, "")).join(", ") || "older"}); the model comparison gave no answer`
    : p.source === "closed" ? `Chosen by: ${clip(p.reasons.join("; "), 100) || "already closed"}` : `Chosen by: ${p.model ?? "model"}, all ${p.group.members.length} compared in one pass`;
  const facts = [...keepFacts, `Close: ${refList(closes)}${stays.length ? `; stays open: ${refList(stays)}` : ""}`, chosen];
  const question = `Keep #${primary.number}${keeps.length > 1 ? ` and #${keeps.find((k) => k !== primary)!.number}` : ""} and close ${refList(closes)} as ${keeps.length > 1 ? "their" : "its"} ${closes.length === 1 ? "duplicate" : "duplicates"}?`;
  const context = byRule
    ? `The model comparison gave no valid answer, so the rule picked the item to keep: ${p.reasons.map((r) => r.replace(/^kept by rule: /, "")).join(", ")}.`
    : `${list(p.group.members)} describe the same bug or request. ${p.model ? `${p.model[0]!.toUpperCase()}${p.model.slice(1)} compared them together` : "They are compared together"}${p.source === "closed" ? "; one is already done, so the open ones duplicate it" : ""}.`;
  return { facts: facts.slice(0, 5), question, context, summary, by, why, keepLabel: `Keep ${list(keeps.map((k) => k.number))}` };
}

/** Asks (or refreshes) the group decisions of one repo (every repo when omitted). Returns the ids asked or refreshed. Each plan is written in one transaction, so no other process sees its members unheld in between. */
export async function askGroupDecisions(db: Db, repo: string | undefined, at: string): Promise<string[]> {
  const asked: string[] = [];
  for (const p of await groupPlans(db, repo)) {
    const id = await db.write(async (): Promise<string | null> => {
      if (!p.closing) {
        // Nothing to close: the pair decisions and an open group decision about these members have no use.
        await supersede(db, p, "", at);
        return null;
      }
      // An answer waiting for Act that already lists every member to close: no second decision.
      const waiting = new Set((await db.all(db.k.selectFrom("decisions as d").innerJoin("dupe_group_items as gi", "gi.decision_id", "d.id").select("gi.number")
        .where("d.kind", "=", "duplicate").where((eb) => kx.like(db, "d.id", eb.val("%:dupegroup:%"))).where("d.repo", "=", p.repo)
        .where("d.answer", "is not", null).where("d.answer", "not in", ["superseded", "distinct", "backlog"]).where("d.applied_at", "is", null))).map((r) => r.number));
      p.items = p.items.filter((i) => !(i.role === "close" && waiting.has(i.number)));
      if (!p.items.some((i) => i.role === "close")) return null;
      const id = await idFor(db, p);
      const t = await textOf(db, p);
      const primary = p.items.find((i) => i.number === p.number)!;
      const alts = (await canonInfo(db, p.repo, p.items.filter((i) => i.kind === primary.kind && i.number !== p.number && i.role !== "stay").map((i) => i.number))).sort(compareCanonical).slice(0, 3);
      const q = {
        id, kind: "duplicate", repo: p.repo, number: p.number, question: t.question, context: t.context, facts: t.facts,
        options: [{ ...GROUP_OPTIONS.accept, label: t.keepLabel }, ...alts.map((a) => ({ key: keepKey(a.number), label: `Keep #${a.number} instead`, hint: `Posts the comments shown under it: keeps #${a.number}, closes the others, #${p.number} too.` })), GROUP_OPTIONS.distinct],
        recommended: t.why ? "accept" : null, recommended_reason: t.why,
        asked_by: ACTOR, asked_at: at, summary: t.summary, summary_by: t.by, summary_at: at,
      };
      await supersede(db, p, id, at);
      // An open decision whose question and member roles are unchanged keeps its asked time and stored texts.
      if (await unchanged(db, q, p)) return null;
      await ask(db, [q], true);
      // ask() keeps the stored summary_by when the new one is empty; the author must follow the text.
      await db.run(db.k.updateTable("main.decisions").set({ summary_by: t.by || null }).where("id", "=", id));
      // A refresh restores the comparison's roles; an answer is applied to them again.
      await db.run(db.k.insertInto("dupe_groups").values({ decision_id: id, repo: p.repo, source: p.source })
        .onConflict((oc) => oc.column("decision_id").doUpdateSet((eb) => ({ source: eb.ref("excluded.source"), applied_answer: null }))));
      await db.run(db.k.deleteFrom("dupe_group_items").where("decision_id", "=", id));
      for (const i of p.items) await db.run(db.k.insertInto("dupe_group_items").values({
        decision_id: id, repo: p.repo, number: i.number, kind: i.kind, role: i.role, target: i.target, detail: i.detail ? JSON.stringify(i.detail) : null,
        base_role: i.role, base_target: i.target, head: await boundHead(db, p, i),
      }));
      await storeOptionTexts(db, id, ["accept", ...alts.map((a) => keepKey(a.number))], async (n) => {
        const r = await db.get(db.k.selectFrom("items").select("state").where("repo", "=", p.repo).where("number", "=", n));
        return r?.state === "OPEN" && await inPilot(db, p.repo, n);
      });
      return id;
    });
    if (id === null) continue;
    asked.push(id);
    await jobItem(db, p.repo, p.number, "asked a duplicate decision", console.log, id);
    await withdrawGroupedQuestions(db, at, p.repo);
  }
  return asked;
}

/** Groups whose plan has no decision yet. Reads only, for the autopilot. */
export async function groupsToAsk(db: Db, repo?: string): Promise<GroupPlan[]> {
  // A plan is asked under a new id unless an open group decision already lists one of its members (idFor), read once for all plans.
  const open = new Set((await db.all(db.k.selectFrom("decisions as d").innerJoin("dupe_group_items as gi", "gi.decision_id", "d.id")
    .select((eb) => eb(eb(eb.ref("gi.repo"), "||", eb.val("#")), "||", kx.exprOf(eb, "gi.number")).as("k"))
    .where("d.kind", "=", "duplicate").where("d.answer", "is", null).where((eb) => kx.like(db, "d.id", eb.val("%:dupegroup:%"))))).map((r) => r.k));
  return (await groupPlans(db, repo)).filter((p) => p.closing && !p.group.members.some((n) => open.has(`${p.repo}#${n}`)));
}

/**
 * Answers to apply: pair decisions answered other than close, and group decisions whose answer is not yet in the roles.
 * Each is listed with the items it concerns (a pair's two, a group's members), so the item plans can carry it.
 */
export async function answersToApply(db: Db): Promise<{ id: string; refs: string[] }[]> {
  const rows = await db.all(db.k.selectFrom("decisions as d").select(["d.id", "d.repo", "d.number"])
    .where("d.kind", "=", "duplicate").where("d.answer", "is not", null).where("d.answer", "<>", "backlog").where("d.applied_at", "is", null)
    .where((eb) => settledByExpr(db, eb, "d"))
    .where((eb) => eb.or([
      eb.and([eb.not(kx.like(db, "d.id", eb.val("%:dupegroup:%"))), eb("d.answer", "<>", "close"), pilotExprFor(db, eb, "d.repo", "d.number")]),
      eb.and([
        kx.like(db, "d.id", eb.val("%:dupegroup:%")),
        eb.exists(eb.selectFrom("dupe_group_items as gi").select(eb.lit(1).as("one")).whereRef("gi.decision_id", "=", "d.id")
          .where((e) => pilotExprFor(db, e, "gi.repo", "gi.number"))),
        eb(eb.fn.coalesce(eb.selectFrom("dupe_groups as g").select("g.applied_answer").whereRef("g.decision_id", "=", "d.id"), eb.val("")), "<>", eb.ref("d.answer")),
      ]),
    ])));
  return await mapSeq(rows, async (d) => {
    if (d.id.includes(":dupegroup:")) return { id: d.id, refs: (await db.all(db.k.selectFrom("dupe_group_items").select(["repo", "number"]).where("decision_id", "=", d.id))).map((m) => `${m.repo}#${m.number}`) };
    const other = /@(\d+)$/.exec(d.id)?.[1];
    return { id: d.id, refs: [`${d.repo}#${d.number}`, ...(other ? [`${d.repo}#${other}`] : [])] };
  });
}

async function markDistinct(db: Db, repo: string, numbers: number[], at: string): Promise<void> {
  for (const x of numbers) for (const y of numbers) {
    if (x >= y) continue;
    await db.run(db.k.updateTable("duplicate_pairs").set({ verdict: "distinct", by_operator: 1 }).where("repo", "=", repo).where("a", "=", x).where("b", "=", y));
    // A pair not stored yet (or stored at other text) still must never be asked again.
    await db.run(db.k.insertInto("duplicate_pairs")
      .columns(["repo", "a", "b", "a_hash", "b_hash", "similarity", "verdict", "by_operator", "created_at", "checked_at"])
      .expression((eb) => eb.selectFrom(["items as ia", "items as ib"]).select((e) => [
        e.val(repo).as("repo"), e.val(x).as("a"), e.val(y).as("b"), "ia.embed_hash as a_hash", "ib.embed_hash as b_hash", e.lit(0).as("similarity"),
        e.val("distinct").as("verdict"), e.lit(1).as("by_operator"), e.val(at).as("created_at"), e.val(at).as("checked_at"),
      ]).where("ia.repo", "=", repo).where("ia.number", "=", x).where("ib.repo", "=", repo).where("ib.number", "=", y)
        .where("ia.embed_hash", "is not", null).where("ib.embed_hash", "is not", null))
      .onConflict((oc) => oc.doNothing()));
  }
}

/** Back to the comparison's roles; the next answer is applied to them. */
async function restoreRoles(db: Db, id: string): Promise<void> {
  await db.run(db.k.updateTable("dupe_group_items").set((eb) => ({ role: eb.ref("base_role"), target: eb.ref("base_target") })).where("decision_id", "=", id));
}

/** An undone answer leaves nothing of it in the roles. */
export async function resetGroupAnswer(db: Db, id: string): Promise<void> {
  if (!id.includes(":dupegroup:")) return;
  await restoreRoles(db, id);
  await db.run(db.k.updateTable("dupe_groups").set({ applied_answer: null }).where("decision_id", "=", id));
}

/** Writes the roles an answer of "keep #N instead" implies: N is kept; the kept item it replaces closes when it is open and in the pilot, else stays. */
async function rekeep(db: Db, id: string, n: number, repo: string): Promise<void> {
  await restoreRoles(db, id);
  const row = await db.get(db.k.selectFrom("dupe_group_items").select("kind").where("decision_id", "=", id).where("number", "=", n));
  if (!row) return;
  const old = await db.all(db.k.selectFrom("dupe_group_items as gi").innerJoin("items as i", (j) => j.onRef("i.repo", "=", "gi.repo").onRef("i.number", "=", "gi.number"))
    .select(["gi.number", "i.state"]).where("gi.decision_id", "=", id).where("gi.kind", "=", row.kind).where("gi.role", "=", "keep").where("gi.number", "<>", n));
  for (const o of old) {
    const closes = o.state === "OPEN" && await inPilot(db, repo, o.number);
    await db.run(db.k.updateTable("dupe_group_items").set({ role: closes ? "close" : "stay", target: closes ? n : null }).where("decision_id", "=", id).where("number", "=", o.number));
  }
  await db.run(db.k.updateTable("dupe_group_items").set({ target: n }).where("decision_id", "=", id).where("kind", "=", row.kind).where("role", "=", "close").where("number", "<>", n));
  await db.run(db.k.updateTable("dupe_group_items").set({ role: "keep", target: null }).where("decision_id", "=", id).where("number", "=", n));
}

/**
 * Operator answers. A pair decision answered "not a duplicate" or "keep both" stores the pair as distinct for
 * good. A group decision answered "not duplicates" does so for every pair of the group; "keep #N instead"
 * rewrites the group's roles; "use this answer" needs no change. Closing is the act step's.
 * With `only`, just the decisions whose ids it holds.
 */
export async function applyDuplicateAnswers(db: Db, at: string, only?: ReadonlySet<string>): Promise<number> {
  let n = 0;
  for (const a of await actionable(db)) {
    if (a.kind !== "duplicate" || a.number === null || a.repo === null) continue;
    if (only && !only.has(a.id)) continue;
    if (a.id.includes(":dupegroup:")) {
      const g = await db.get(db.k.selectFrom("dupe_groups").select("applied_answer").where("decision_id", "=", a.id));
      if (!g || g.applied_answer === a.answer) continue;
      await restoreRoles(db, a.id);
      const members = (await db.all(db.k.selectFrom("dupe_group_items").select("number").where("decision_id", "=", a.id))).map((r) => r.number);
      const kept = keptOf(a.answer);
      if (a.answer === "distinct") {
        await markDistinct(db, a.repo, members, at);
        await db.run(db.k.updateTable("main.decisions").set({ applied_at: at }).where("id", "=", a.id).where("applied_at", "is", null));
      } else if (kept !== null) await rekeep(db, a.id, kept, a.repo);
      await db.run(db.k.updateTable("dupe_groups").set({ applied_answer: a.answer }).where("decision_id", "=", a.id));
      await audit(db, ACTOR, "duplicate-answer", `${a.repo}#${a.number}`, { decision: a.id, answer: a.answer });
      n++;
      continue;
    }
    if (a.answer === "close") continue;
    const d = (await getDecision(db, a.id))!;
    const f = factsOf(d).find((x) => x.startsWith(DUP_FACT))?.slice(DUP_FACT.length);
    const m = f ? /^([\w.-]+)#(\d+)$/.exec(f) : null;
    if ((a.answer === "distinct" || a.answer === "keep") && m) await markDistinct(db, a.repo, [a.number, Number(m[2])], at);
    await db.run(db.k.updateTable("main.decisions").set({ applied_at: at }).where("id", "=", a.id).where("applied_at", "is", null));
    await audit(db, ACTOR, "duplicate-answer", `${a.repo}#${a.number}`, { decision: a.id, answer: a.answer });
    n++;
  }
  return n;
}
