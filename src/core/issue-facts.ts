// Facts of open items (issues and PRs) for the triage steps: classification, priority, embedding, duplicates, scope decision, labels.
// Loaded in one pass for a whole database or a slice. Reads only: the old selectors fill missing text hashes in the database on the way; here a missing hash is computed.
import { settleMemo, settledBy, settlesNow } from "../settlers.ts";
import { featureOn } from "../build/features.ts";
import { latestAttempts, liveByRepo, type LatestAttempt } from "../implement/store.ts";
import { ENDED_STATES, LIVE_STATES } from "../implement/types.ts";
import { isBotLogin } from "../review/bots.ts";
import { ownLoginTest } from "../github/identity.ts";
import { groupClosersPending } from "../act/dupe-groups.ts";
import { pipelineWrites } from "./rules.ts";
import { assignmentsOf, ownFixPrs, refreshTimes } from "./facts.ts";
import { activeTrips } from "../push-outcomes.ts";
import { tripsOfRepo } from "./push-outcome.ts";
import { notOwnIntegrationExpr, groupHeldExpr, backlogHeldExpr } from "../dupes/held.ts";
import { FAST_FLOOR, fastScoreExpr } from "../fasttrack.ts";
import { latestRun, needsDecisionOf, refereeClosed, securityOf, settle, topOf, SURE, type Referee } from "../classify/settled.ts";
import { JEV_FLAG_NO, JEV_NEEDS_DECISION_YES, JEV_SECURITY_YES } from "../classify/parse.ts";
import { answersToApply, groupsToAsk } from "../dupes/decide.ts";
import { uncheckedPairCounts } from "../dupes/check.ts";
import { dueSets, ruleOutcome } from "../dupes/plan.ts";
import { embedderId, modelName } from "../embed/model.ts";
import { classifyHash, embedHash as hashOfText, SCHEME_ID } from "../itemhash.ts";
import { actionable } from "../decisions.ts";
import { commentApprovalOf } from "../act/approval.ts";
import { TERMINAL } from "../build/tasks.ts";
import { fixIssueApprovalOf } from "../implement/approval.ts";
import { issuesWithOpenPrAll, type OpenPr, notRustKey, textHash } from "./open-prs.ts";
import { headOf, scopeAnswers, unsettledScope } from "../review/candidates.ts";
import { approvalOf as labelsApprovalOf } from "../labels/approval.ts";
import { pilotExpr } from "../pilot.ts";
import { holdMap } from "../outside.ts";
import { RUNNING_STALE_MS, lockLiveExpr, lockRunningAtExpr } from "../answers/hold.ts";
import { DISCUSSION_PREPARES_PER_DAY, PREPARE_DAILY_CAP, isPreparing, prepareStateExpr, utcDayStart } from "../decide/prepared.ts";
import { nextUtcMidnight } from "../review/discussion.ts";
import type { ItemFacts } from "./plan.ts";
import { setting, hasSetting } from "../settings-read.ts";
import { mapSeq } from "../async-seq.ts";
import { loadWorkflowFacts } from "../workflow/facts.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

export type { ItemFacts } from "./plan.ts";

export type ItemLoadOptions = {
  repo?: string;
  /** Only these items, as "repo#number". */
  refs?: Iterable<string>;
  /** Decision time in ms (default: the clock). */
  now?: number;
  /** The embedding model whose vectors count (default: the configured one). */
  model?: string;
  /** The classification run (default: latestRun, the current run else the newest verdict run). */
  run?: string | null;
};

// The stored hashes that follow the item's text hash are read as '' when they equal it (asText() restores them), so the common case sends no copy.
const sameAsText = (eb: kx.AnyEb, col: string) => eb.case().when(eb.ref(col), "=", eb.ref("i.embed_hash")).then(eb.val("")).else(eb.ref(col)).end();
const asText = (h: string | null, text: string | null): string | null => (h === "" ? text : h);

const itemRows = (db: Db, model: string) => db.k.selectFrom("items as i").innerJoin("tracked_repos as t", "t.name", "i.repo")
  .leftJoin("item_rank as r", (j) => j.onRef("r.repo", "=", "i.repo").onRef("r.number", "=", "i.number"))
  .leftJoin("item_priority as p", (j) => j.onRef("p.repo", "=", "i.repo").onRef("p.number", "=", "i.number"))
  .leftJoin("item_embeddings as e", (j) => j.onRef("e.repo", "=", "i.repo").onRef("e.number", "=", "i.number").on("e.model", "=", model))
  .leftJoin("duplicate_scans as s", (j) => j.onRef("s.repo", "=", "i.repo").onRef("s.number", "=", "i.number"))
  .leftJoin("item_stage as st", (j) => j.onRef("st.repo", "=", "i.repo").onRef("st.number", "=", "i.number"))
  .leftJoin("fix_attempts as fa", (j) => j.onRef("fa.repo", "=", "i.repo").onRef("fa.number", "=", "i.number"))
  .leftJoin("build_tasks as ht", "ht.id", "fa.head_task_id").leftJoin("build_tasks as bt", "bt.id", "fa.base_task_id")
  .select((eb) => ["i.repo", "i.number", "i.kind", "i.state", "i.author", "i.assignees", "i.is_draft", "i.updated_at", "i.labels", "i.embed_hash",
    eb.case().when("i.class_scheme", "=", SCHEME_ID).then(eb.ref("i.class_hash")).end().as("class_hash"), "i.jev_failed_hash",
    fastScoreExpr(db, eb, "i.repo", "i.number", "r.score").as("score"),
    pilotExpr(db, eb, "i").as("in_pilot"), notOwnIntegrationExpr(db, eb, "i").as("not_integration"), backlogHeldExpr(db, eb, "i").as("held_backlog"),
    eb.or([
      eb.exists(kx.schemaEb(eb).selectFrom("decisions as dh").select(eb.lit(1).as("one")).where("dh.kind", "=", "duplicate").where(eb.not(kx.like(db, "dh.id", eb.val("%:dupegroup:%"))))
        .where("dh.repo", "=", eb.ref("i.repo")).where("dh.number", "=", eb.ref("i.number")).where((w) => w.or([w("dh.answer", "is", null), w("dh.answer", "=", "close")]))),
      groupHeldExpr(db, eb, "i"),
    ]).as("held_dup"),
    sameAsText(eb, "p.text_hash").as("pr_hash"), "p.impact", sameAsText(eb, "e.hash").as("e_hash"), sameAsText(eb, "s.hash").as("scan_hash"), "st.stage",
    "fa.state as a_state", "fa.pr_url as a_pr", "fa.text_hash as a_hash", "fa.head_task_id as a_head", "fa.base_task_id as a_base", "ht.state as h_state", "bt.state as b_state"])
  .$narrowType<{ kind: "pr" | "issue" }>();

/** `asked_by` of the decisions a security scan asks (act/index.ts SECURITY_ASKER). */
const SECURITY_ASKER = "security-scan";
/** Kind of the actions row Act writes for a comment-and-close. */
const ACT_KIND = "comment-close";

const json = <T>(s: string | null, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };
const flagsOf = (s: string | null): string[] => { const f = json<unknown>(s, []); return Array.isArray(f) ? f.filter((x): x is string => typeof x === "string") : []; };
const refsOf = (d: { repo: string | null; number: number | null; items: string | null }): string[] =>
  d.number !== null ? [`${d.repo}#${d.number}`] : json<{ repo: string; number: number }[]>(d.items, []).map((r) => `${r.repo}#${r.number}`);

type Cls = { classifier: string; at: string; type_label: string | null; flags: string | null; probs: string | null; input_hash: string | null };

/** Facts of every open item (issue or PR) of the tracked repos, for the database, repo or refs given. */
export async function loadItemFacts(db: Db, opts: ItemLoadOptions = {}): Promise<ItemFacts[]> {
  const now = opts.now ?? Date.now();
  // Clock-driven changes of the facts below (a card's lock going stale, daily prepare counts, duplicate retries and pauses), per item.
  const refresh = refreshTimes(now);
  const model = opts.model ?? embedderId(modelName());
  const pipelineOn = pipelineWrites(await setting(db, "pipeline_enabled"));

  // Values read once for all items.
  const tripped = await activeTrips(db);
  const run = opts.run !== undefined ? opts.run : await latestRun(db);
  const memo = settleMemo();
  const outsideHolds = await holdMap(db);
  const answers = await scopeAnswers(db);
  const operatorAnswers = await scopeAnswers(db, true);
  const unsettled = await unsettledScope(db);
  const latestScope = new Map<string, { answer: string | null; byOperator: boolean }>(), securityIds = new Set<string>();
  // Kind and head of every item an open decision is about.
  const heads = new Map((await db.all(db.k.selectFrom("decisions as d").innerJoin("items as i", (j) => j.onRef("i.repo", "=", "d.repo").onRef("i.number", "=", "d.number"))
    .select((eb) => [eb(eb("i.repo", "||", eb.val("#")), "||", kx.exprOf(eb, "i.number")).as("k"), "i.kind", "i.head_oid"]).distinct().where("d.answer", "is", null)))
    .map((r) => [r.k, r]));
  const openScope = new Set<string>(), covered = new Set<string>(), recommend = new Map<string, { failures: number; failedAt: string | null }>();
  // Only the decisions the loop reads: open ones, scope and backlog answers, and security asks.
  for (const d of await db.all(db.k.selectFrom("decisions").select((eb) => ["id", "kind", "repo", "number", "items", "answer", "answered_by", "asked_by", "prepared_at", "prepared_head", "prepare_failed_head", "recommend_failures", "recommend_failed_at", "prepared_discussion", "prepare_requested_at",
      ...prepareStateExpr(db, eb, "decisions", utcDayStart(now)), lockLiveExpr(db, eb, "decisions", new Date(now)).as("locked"), lockRunningAtExpr(db, eb, "decisions").as("lock_at")])
    .$narrowType<{ review_queued: 0 | 1 }>()
    .where((eb) => eb.or([eb("answer", "is", null), eb("kind", "=", "scope"), eb("answer", "=", "backlog"), eb("asked_by", "=", SECURITY_ASKER)]))
    .orderBy("asked_at").orderBy("id"))) {
    const dupegroup = d.id.includes(":dupegroup:");
    if (d.kind === "scope" && d.number !== null && !(d.answer === "withdrawn" && d.answered_by === "pipeline")) latestScope.set(`${d.repo}#${d.number}`, { answer: d.answer, byOperator: await settledBy(db, d, memo) });
    if (d.asked_by === SECURITY_ASKER) securityIds.add(d.id);
    if (d.kind === "scope" && d.answer === null) {
      for (const r of refsOf(d)) openScope.add(r);
    }
    // Any open decision of one item that the prepare step has not covered at the item's current head (the item's fewest failed tries win).
    if (d.answer === null && d.number !== null) {
      const k = `${d.repo}#${d.number}`;
      const it = heads.get(k);
      const h = it?.kind === "pr" ? it.head_oid : null;
      const preparing = isPreparing({ ...d, prepares_today: d.prepares_today ?? undefined }, h);
      // A decision whose press is running or queued is locked and not prepared.
      if (preparing && d.locked && d.lock_at) refresh.soon(k, Date.parse(d.lock_at) + RUNNING_STALE_MS);
      // The day's automatic prepares count towards caps that end at UTC midnight.
      if ((d.prepares_today ?? 0) >= Math.min(DISCUSSION_PREPARES_PER_DAY, PREPARE_DAILY_CAP)) refresh.soon(k, nextUtcMidnight(now));
      if (preparing && !d.locked) {
        const failures = (d.prepare_failed_head ?? null) === h ? d.recommend_failures ?? 0 : 0;
        if (failures < (recommend.get(k)?.failures ?? Infinity)) recommend.set(k, { failures, failedAt: failures ? d.recommend_failed_at : null });
      }
    }
    // A question the pipeline withdrew (its item closed) does not cover the item: if it reopens, it is asked again.
    const withdrawn = d.answer === "withdrawn" && d.answered_by === "pipeline";
    // A maintainer's scope answer that no longer counts (src/settlers.ts) covers nothing: the item needs a decision again.
    const lapsed = d.kind === "scope" && d.answer !== null && refsOf(d).every((r) => unsettled.has(r));
    if ((d.answer === null || d.kind === "scope" || d.answer === "backlog") && (!dupegroup || d.answer === null) && !withdrawn && !lapsed) for (const r of refsOf(d)) covered.add(r);
  }
  const labeled = new Map((await db.all(db.k.selectFrom("stages").select(["repo", "number", "note"]).where("stage", "=", "labeled").orderBy("at").orderBy(kx.rowid("stages"))))
    .map((s) => [`${s.repo}#${s.number}`, s.note]));
  const own = await ownFixPrs(db, opts.repo);
  const assigned = await assignmentsOf(db, opts.repo);
  const pairs = await uncheckedPairCounts(db, { repo: opts.repo, refs: opts.refs });
  const dupeAnswers = new Map<string, string[]>();
  for (const a of await answersToApply(db)) for (const r of a.refs) (dupeAnswers.get(r) ?? dupeAnswers.set(r, []).get(r)!).push(a.id);
  // Group-level work (which groups to ask about, which sets to compare) is planned per group by dupes/decide.ts and dupes/plan.ts; the items carry its result.
  const inGroup = new Set((await groupsToAsk(db, opts.repo)).flatMap((g) => g.group.members.map((n) => `${g.repo}#${n}`)));
  const inCompare = new Map<string, "rule" | "model">();
  const dueAt = (s: { repo: string; members: { number: number }[] }, at: number): void => { for (const m of s.members) refresh.soon(`${s.repo}#${m.number}`, at); };
  for (const s of await dueSets(db, opts.repo, now, dueAt)) {
    const how = ruleOutcome(s) === null ? "model" : "rule";
    for (const m of s.members) { const ref = `${s.repo}#${m.number}`; if (inCompare.get(ref) !== "model") inCompare.set(ref, how); }
  }
  const approved = new Map<string, boolean>();
  const labelsApproved = async (repo: string) => approved.get(repo) ?? (approved.set(repo, await labelsApprovalOf(db, repo) !== null), approved.get(repo)!);
  // Act: answers an operator gave that close an item (decisions.ts actionable, as act/index.ts targetsOf reads them).
  const actionState = new Map((await db.all(db.k.selectFrom("actions").select(["decision_id", "repo", "number", "state"]).where("kind", "=", ACT_KIND)))
    .map((a) => [`${a.decision_id}|${a.repo}#${a.number}`, a.state]));
  const waitingExec = new Set((await db.all(db.k.selectFrom("main.decisions").select("id").where("exec_state", "in", ["waiting-token", "waiting-permission"]).where("applied_at", "is", null))).map((r) => r.id));
  const answeredClose = new Map<string, ItemFacts["answeredClose"]>();
  const actionableNow = await actionable(db);
  for (const a of actionableNow) {
    if (a.kind !== "scope" && a.kind !== "close" && a.kind !== "duplicate" && a.kind !== "merge" && a.kind !== "hold") continue;
    if (a.kind !== "scope" && a.number === null) continue;
    for (const it of a.items) {
      const ex = a.exceptions.find((e) => e.repo === it.repo && e.number === it.number);
      if ((ex ? ex.answer : a.answer) !== "close") continue;
      const k = `${it.repo}#${it.number}`;
      (answeredClose.get(k) ?? answeredClose.set(k, []).get(k)!).push({ decisionId: a.id, kind: a.kind, security: securityIds.has(a.id), action: actionState.get(`${a.id}|${k}`) ?? null, ...(waitingExec.has(a.id) ? { waiting: true } : {}) });
    }
  }
  // Duplicate group answers: the Act step closes the members the group decision names; each member without a close record is a target.
  for (const g of await groupClosersPending(db)) {
    if (opts.repo && g.repo !== opts.repo) continue;
    const k = `${g.repo}#${g.number}`;
    (answeredClose.get(k) ?? answeredClose.set(k, []).get(k)!).push({ decisionId: g.decisionId, kind: "duplicate", security: false, action: null, group: true, ...(waitingExec.has(g.decisionId) ? { waiting: true } : {}) });
  }
  // A closed item stays in the facts while an answered close of it is not applied: the Act step records it as already closed.
  const closing = [...answeredClose].filter(([, t]) => t.some((x) => x.action === null || x.action === "failed")).map(([ref]) => ref);
  const rows = await db.all(itemRows(db, model).where((eb) => eb.or([eb("i.state", "=", "OPEN"), kx.refIn(db, "i", closing)]))
    .$if(!!opts.repo, (q) => q.where("i.repo", "=", opts.repo!)).$if(!!opts.refs, (q) => q.where(kx.refIn(db, "i", opts.refs!)))
    .orderBy("i.repo").orderBy("i.number"));
  // The run's verdicts of the items loaded. Jev's per-type probabilities are left out: only its top, security and needs_decision values are read.
  const byItem = new Map<string, Cls[]>();
  if (run) {
    for (const c of await db.all(db.k.selectFrom("classifications as c").select((eb) => ["c.repo", "c.number", "c.classifier", "c.at", "c.type_label", "c.flags",
        eb.case().when(eb.and([eb("c.classifier", "=", "jev"), kx.jsonValid(db, "c.probs")])).then(kx.jsonRemoveKey(db, "c.probs", "type")).else(eb.ref("c.probs")).end().as("probs"), "c.input_hash"])
      .where("c.run_id", "=", run).where(kx.refIn(db, "c", rows.map((r) => [r.repo, r.number] as const))))) {
      const k = `${c.repo}#${c.number}`;
      (byItem.get(k) ?? byItem.set(k, []).get(k)!).push(c);
    }
  }
  const closeReview = new Map<string, NonNullable<ItemFacts["closeReview"]>>();
  for (const r of await db.all(db.k.selectFrom("final_reviews as r").innerJoin("items as i", (j) => j.onRef("i.repo", "=", "r.repo").onRef("i.number", "=", "r.number").on("i.kind", "=", "pr").on("i.state", "=", "OPEN"))
    .leftJoin("pr_checks as c", (j) => j.onRef("c.repo", "=", "r.repo").onRef("c.number", "=", "r.number"))
    .select((eb) => ["r.repo", "r.number", "r.head_oid", "i.head_oid as i_head", "i.updated_at", "c.head_oid as c_head", "c.fetched_at as c_at",
      eb.exists(eb.selectFrom("decisions as d").select(eb.lit(1).as("one"))
        .where("d.id", "=", eb(eb(eb(eb(eb.ref("r.repo"), "||", eb.val("#")), "||", kx.exprOf(eb, "r.number")), "||", eb.val(":close@")), "||", eb.ref("r.head_oid")))).as("asked")])
    .$narrowType<{ repo: string; number: number; head_oid: string }>()
    .where("r.verdict", "=", "close")
    .where("r.head_oid", "=", (eb) => eb.selectFrom("opus_reviews as r2").select("r2.head_oid").whereRef("r2.repo", "=", "r.repo").whereRef("r2.number", "=", "r.number").where("r2.verdict", "is not", null)
      .orderBy("r2.at", "desc").orderBy(kx.rowid("opus_reviews", "r2"), "desc").limit(1))))
    closeReview.set(`${r.repo}#${r.number}`, { head: r.head_oid, atHead: headOf({ head_oid: r.i_head, updated_at: r.updated_at, c_head: r.c_head, c_at: r.c_at }) === r.head_oid, asked: !!r.asked });
  const repoMemo = new Map<string, { comment: boolean; fix: boolean; implement: boolean; pub: boolean; notRust: boolean; openPrs: Map<number, OpenPr> }>();
  // Public repos and open PRs, read once for every repo on first use.
  let tables: { pub: Set<string>; openPrs: (repo: string) => Map<number, OpenPr> } | undefined;
  const repoOf = async (repo: string) => {
    let m = repoMemo.get(repo);
    if (!m) {
      const t = (tables ??= { pub: new Set((await db.all(db.k.selectFrom("repos").select("name").where("visibility", "=", "public"))).map((x) => x.name)), openPrs: await issuesWithOpenPrAll(db) });
      m = { comment: await commentApprovalOf(db, repo) !== null, fix: await fixIssueApprovalOf(db, repo) !== null, implement: await featureOn(db, "implement", repo), pub: t.pub.has(repo),
        notRust: await hasSetting(db, notRustKey(repo)), openPrs: t.openPrs(repo) };
      repoMemo.set(repo, m);
    }
    return m;
  };
  // Implement: who queued each issue (its fast_track row; in a repo on the maintainer workflow, who started its live implement
  // workflow), its latest attempt, and the live attempts per repo.
  const wfs = await loadWorkflowFacts(db, opts.repo);
  const fastQueued = new Map((await db.all(db.k.selectFrom("fast_track").select(["repo", "number", "added_by", "added_at"]).$if(!!opts.repo, (q) => q.where("repo", "=", opts.repo!))))
    .map((r) => [`${r.repo}#${r.number}`, { by: r.added_by, at: r.added_at }]));
  const queuedOf = (repo: string, number: number): { by: string; at: string } | null => {
    if (wfs.model(repo) !== "new") return fastQueued.get(`${repo}#${number}`) ?? null;
    const w = wfs.live(repo, number);
    return w?.entry === "implement" ? { by: w.startedBy, at: w.startedAt } : null;
  };
  const attempts = await latestAttempts(db, opts.repo);
  const liveImpl = await liveByRepo(db);
  const implDecisions = [...new Set([...attempts.values()].flatMap((a) => (a.decisionId ? [a.decisionId] : [])))];
  const answeredAt = new Map(implDecisions.length ? (await db.all(db.k.selectFrom("decisions").select(["id", "answered_at"]).where("id", "in", implDecisions).where("answer", "is not", null))).map((d) => [d.id, d.answered_at ?? ""]) : []);
  // An answer that waits for its person's sign-in or access, or is disputed, is not work for the plan or build bucket until that clears.
  const implHeld = new Set(implDecisions.length ? (await db.all(db.k.selectFrom("decisions").select("id").where("id", "in", implDecisions).where("exec_state", "in", ["waiting-token", "waiting-permission", "disputed"]))).map((d) => d.id) : []);
  // A stuck attempt's answer counts once someone who settles on the repo gave it and it is not Backlog (actionable()), as applyStuckAnswer reads it.
  const settledIds = new Set(actionableNow.map((a) => a.id));
  // Answers count only when they came after the attempt's newest question (else after it last moved): a re-plan that asks again
  // writes a new question round, so the answers it already read do not plan it again.
  const askedSince = (a: LatestAttempt): string => a.question?.at ?? a.updatedAt;
  const implPrs = [...attempts.values()].flatMap((a) => (a.prNumber !== null ? [[a.repo, a.prNumber] as const] : []));
  const prState = new Map(implPrs.length ? (await db.all(db.k.selectFrom("items as i").select(["i.repo", "i.number", "i.state"]).where(kx.refIn(db, "i", implPrs)))).map((r) => [`${r.repo}#${r.number}`, r.state]) : []);
  // A person's comment after an asked attempt's question: not a bot's and not ours (the box account or the app's bot, which the mirror stores as a bare slug).
  const commentedAfter = new Set<string>();
  const ownTests = new Map<string, (login: string | null) => boolean>();
  for (const a of attempts.values()) {
    if (a.state !== "asked") continue;
    const later = await db.all(db.k.selectFrom("comments").select("author").where("repo", "=", a.repo).where("number", "=", a.number).where("created_at", ">", askedSince(a)));
    if (!later.length) continue;
    const own = ownTests.get(a.repo) ?? ownTests.set(a.repo, await ownLoginTest(db, a.repo)).get(a.repo)!;
    if (later.some((c) => c.author !== null && !own(c.author) && !isBotLogin(c.author))) commentedAfter.add(`${a.repo}#${a.number}`);
  }
  const settles = settleMemo();
  // Item text, read only for the rows that need it (an implementation attempt, a missing text hash, a classifier hash to recompute), in one query.
  const classed = (ref: string): boolean => (byItem.get(ref) ?? []).some((c) => c.classifier === "jev" || (c.classifier === "haiku" && c.input_hash !== null));
  const needText = rows.filter((r) => (r.kind === "issue" && attempts.has(`${r.repo}#${r.number}`)) || r.embed_hash === null || (r.class_hash === null && classed(`${r.repo}#${r.number}`)));
  const texts = new Map(needText.length ? (await db.all(db.k.selectFrom(kx.refPairs(db, needText.map((r) => [r.repo, r.number] as const), "j"))
    .innerJoin("items as i", (j) => j.onRef("i.repo", "=", "j.repo").onRef("i.number", "=", "j.number"))
    .select(["i.repo", "i.number", "i.kind", "i.title", "i.body", "i.additions", "i.deletions", "i.changed_files", "i.author_association"]))).map((t) => [`${t.repo}#${t.number}`, t]) : []);
  const mirrored = (repo: string, number: number) => db.get(db.k.selectFrom("items").select((eb) => eb.lit(1).as("one")).where("repo", "=", repo).where("number", "=", number).where("kind", "=", "pr"));
  // The fix PR we just opened counts as open until a sync mirrors it: the mirror's open-PR list doesn't have it yet.
  const ownPrUnmirrored = async (state: string | null, url: string | null): Promise<OpenPr | null> => {
    const m = state === "pr-opened" ? /\/([^/]+)\/pull\/(\d+)$/.exec(url ?? "") : null;
    return m && !await mirrored(m[1]!, Number(m[2])) ? { number: Number(m[2]), closes: true } : null;
  };

  return await mapSeq(rows, async (r): Promise<ItemFacts> => {
    const ref = `${r.repo}#${r.number}`;
    const refreshAt = refresh.at(ref);
    const cls = byItem.get(ref) ?? [];
    const j = cls.find((c) => c.classifier === "jev");
    // A Haiku row without a Jev row counts only when Haiku classified alone (it carries the item's input hash).
    const h = cls.find((c) => c.classifier === "haiku" && (j || c.input_hash !== null));
    const s = cls.find((c) => c.classifier === "sonnet");
    let referee: Referee | null = null;
    if (s && j && h && s.at >= j.at && s.at >= h.at) {
      const p = json<{ sure?: unknown; final?: unknown; opusFailures?: unknown; opusFailedAt?: unknown } | null>(s.probs, null);
      if (typeof p?.sure === "boolean" && s.type_label !== null) referee = { label: s.type_label, sure: p.sure, reason: "", ...(p.final === true && { final: true }), ...(typeof p.opusFailures === "number" && { failures: p.opusFailures }), ...(typeof p.opusFailedAt === "string" && { failedAt: p.opusFailedAt }) };
    }
    const settled = settle(
      j && j.type_label !== null ? { label: j.type_label, flags: flagsOf(j.flags), top: topOf(j.probs), nd: needsDecisionOf(j.probs), sec: securityOf(j.probs) } : null,
      h && h.type_label !== null ? { label: h.type_label, flags: flagsOf(h.flags) } : null,
      referee,
    );
    // The classifier's input hash: stored on the row, recomputed when it was made under another scheme.
    let classHash = r.class_hash;
    if (classHash === null && (j || h)) {
      classHash = classifyHash(texts.get(ref)!);
    }
    const unsureFlag = (key: string, yes: number): boolean => {
      const p = (json<Record<string, unknown> | null>(j?.probs ?? null, null) ?? {})[key];
      return typeof p === "number" && p >= JEV_FLAG_NO && p < yes;
    };
    const jev = j ? {
      at: j.at,
      changed: j.input_hash !== null ? j.input_hash !== classHash : (r.updated_at ?? "") > j.at,
      unsure: (topOf(j.probs) ?? 0) < SURE || unsureFlag("security", JEV_SECURITY_YES) || unsureFlag("needs_decision", JEV_NEEDS_DECISION_YES),
    } : null;
    const haiku = h ? { at: h.at, aloneCurrent: h.input_hash !== null && h.input_hash === classHash && (!j || h.at > j.at) } : null;
    // Sync and Embed write the text hash; one not written yet is computed here.
    const embedHash = r.embed_hash ?? (() => { const b = texts.get(ref)!; return hashOfText(b.title, b.body); })();
    const note = labeled.get(ref) ?? null;
    return {
      repo: r.repo, number: r.number, kind: r.kind, open: r.state === "OPEN", assignment: assigned(ref, r.assignees), now, ...(refreshAt !== undefined ? { refreshAt } : {}), pipelineOn, tripped: tripsOfRepo(tripped, r.repo), inFlight: r.state === "OPEN" && ((r.kind === "issue" && LIVE_STATES.has(attempts.get(ref)?.state ?? "failed")) || (r.kind === "pr" && own.prs.has(ref) && await own.isOwn(r.repo, r.author))), draft: !!r.is_draft,
      inScope: !!r.in_pilot, ...(outsideHolds.has(ref) ? { outsideHold: outsideHolds.get(ref)! } : {}), integration: !r.not_integration,
      held: r.held_backlog ? "backlog" : r.held_dup ? "duplicate" : null,
      fast: (r.score ?? 0) >= FAST_FLOOR, score: r.score, repoFacts: { labelsApproved: await labelsApproved(r.repo), commentApproved: (await repoOf(r.repo)).comment, fixIssueApproved: (await repoOf(r.repo)).fix, workflow: wfs.model(r.repo) },
      ...(wfs.model(r.repo) === "new" ? { workflow: wfs.live(r.repo, r.number), endedWorkflow: wfs.ended(r.repo, r.number) } : {}),
      run,
      classification: {
        status: settled.status, label: settled.label, flags: settled.flags, jevLabel: settled.jevLabel, haikuLabel: settled.haikuLabel,
        referee: settled.referee ? { sure: settled.referee.sure, final: refereeClosed(settled.referee), failedAt: settled.referee.failedAt ?? null } : null, jev, haiku,
        jevFailed: classHash !== null && r.jev_failed_hash === classHash,
      },
      embedHash, embeddedHash: asText(r.e_hash, r.embed_hash), priorityHash: asText(r.pr_hash, r.embed_hash), scannedHash: asText(r.scan_hash, r.embed_hash),
      pairsToCheck: pairs.get(ref) ?? 0, inGroupToAsk: inGroup.has(ref), inCompareSet: inCompare.get(ref) ?? false, dupeAnswers: dupeAnswers.get(ref) ?? [],
      scope: { open: openScope.has(ref), answer: answers.get(ref) ?? null, covered: covered.has(ref), recommend: recommend.get(ref) ?? null },
      labels: { quietFix: own.quiet.has(ref), existing: json<unknown[]>(r.labels, []).map(String), pluginAnswer: operatorAnswers.get(ref) === "plugin", labeledNote: note },
      answeredClose: answeredClose.get(ref) ?? [],
      closeReview: closeReview.get(ref) ?? null,
      fix: {
        attempt: r.a_state === null ? null : {
          state: r.a_state,
          textChanged: false,
          headDone: r.h_state !== null && (TERMINAL as string[]).includes(r.h_state),
          baseDone: r.a_base === null || (r.b_state !== null && (TERMINAL as string[]).includes(r.b_state)),
        },
        publicRepo: (await repoOf(r.repo)).pub, notRust: (await repoOf(r.repo)).notRust, openPr: r.kind === "issue" ? (await repoOf(r.repo)).openPrs.get(r.number) ?? await ownPrUnmirrored(r.a_state, r.a_pr) : null, impact: r.impact,
        scopeDecision: latestScope.get(ref) ?? null,
      },
      implement: await (async () => {
        const q = r.kind === "issue" ? queuedOf(r.repo, r.number) : null, by = q?.by ?? null;
        const a = r.kind === "issue" ? attempts.get(ref) : undefined;
        const live = liveImpl.get(r.repo);
        return {
          queuedBy: by, settles: by !== null && await settlesNow(db, by, [r.repo], settles), featureOn: (await repoOf(r.repo)).implement,
          row: a ? {
            state: a.state, attempt: a.attempt,
            textChanged: (() => { const b = texts.get(ref)!; return textHash(b.title ?? "", b.body ?? "") !== a.textHash; })(),
            newCommentAfterQuestion: commentedAfter.has(ref),
            decisionAnswered: a.decisionId !== null && !implHeld.has(a.decisionId)
              && (a.state === "stuck" ? settledIds.has(a.decisionId) : a.state === "asked" && (answeredAt.get(a.decisionId) ?? "") > askedSince(a)),
            asked: a.state === "asked" ? a.question?.audience ?? (a.decisionId !== null ? "maintainer" : "author") : null,
            requeuedAfterEnd: ENDED_STATES.has(a.state) && q !== null && q.at > a.updatedAt,
            prOpen: a.prNumber !== null && (prState.get(`${r.repo}#${a.prNumber}`) ?? "OPEN") === "OPEN",
          } : null,
          liveInRepo: (live?.size ?? 0) - (live?.has(ref) ? 1 : 0),
        };
      })(),
    };
  });
}

/** Facts of one open item, or null. */
export async function loadItemFact(db: Db, repo: string, number: number, opts: Omit<ItemLoadOptions, "repo" | "refs"> = {}): Promise<ItemFacts | null> {
  return (await loadItemFacts(db, { ...opts, repo, refs: [`${repo}#${number}`] }))[0] ?? null;
}
