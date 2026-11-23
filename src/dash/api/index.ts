// JSON API for the dashboard frontend (web/src/api/client.ts `Api`). The
// server has already checked the session, and on POSTs the Origin, the CSRF
// header and the per-session limits; these handlers check roles and GitHub
// permissions themselves. Item and comment text is returned as data only.
import { live } from "./live.ts";
import { mayRunRepo } from "../repo-access.ts";
import { isHiddenRepo, type HiddenRepos } from "../../hidden-sql.ts";
import * as kx from "../../db/kx.ts";
import { prBuildView } from "../../prbuild/view.ts";
import { checksOf } from "../../patchcheck/index.ts";
import { priorityOf } from "../../priority/read.ts";
import { preapprovalOf } from "../../preapproval/index.ts";
import type {
  CiState, DecisionKind, Done, Funnel, Item, ItemAction, ItemComment, ItemFixup, ItemPremerge, ItemReviews, ItemState, ItemVerification, ReviewSide, Mergeable, Progress, RepoProgress, Tier, User,
} from "../../../web/src/api/types.ts";
import { trackedNames } from "../../repos.ts";
import { excludeHiddenExpr, hiddenRepos, allVisibleRepos, needVisible, repoOwners, visibleRepos } from "./visible.ts";
import { withoutHiddenExpr } from "./decisions.ts";
import { contributors } from "../../whitelist.ts";
import { doneByRepo, funnelByRepo, latestCteExpr, trackedExpr, trackingStart, trend, type DoneRow, type FunnelRow } from "./stats.ts";
import { HttpError, RateLimiter, share } from "../server/util.ts";
import { findingsOf, type PremergeRow } from "../../premerge/store.ts";
import type { Req, Res, Route } from "../types.ts";
import * as adm from "./admin.ts";
import { githubUserId } from "../../github/users.ts";
import { maintainersSettle } from "../../settlers.ts";
import * as discord from "./discord.ts";
import * as agents from "./agents.ts";
import * as build from "./build.ts";
import * as workspaces from "./workspaces.ts";
import * as dec from "./decisions.ts";
import * as conv from "./conversations.ts";
import * as mcp from "./mcp.ts";
import * as userSettings from "./user-settings.ts";
import * as runners from "./runners.ts";
import * as modelQueue from "./model-queue.ts";
import * as areas from "./areas.ts";
import * as security from "./security.ts";
import * as securityPage from "./security-page.ts";
import * as insight from "./insight.ts";
import * as pipeline from "./pipeline.ts";
import * as outside from "./outside.ts";
import { prompts } from "./prompts.ts";
import { queue, queueBatches } from "./queue.ts";
import { next } from "./next.ts";
import { work } from "./work.ts";
import { flow } from "./flow.ts";
import { now, nowFeed } from "./now.ts";
import { queueSlots } from "../../rank/position.ts";
import * as items from "./items.ts";
import { activity } from "./activity.ts";
import { downloads } from "./downloads.ts";
import { itemPage } from "./item-page.ts";
import { trace as itemTrace, traceDetail as itemTraceDetail } from "./trace.ts";
import { postmergeOf } from "./postmerge.ts";
import * as nightly from "./nightly.ts";
import { canSeeInternals } from "./staff.ts";
import * as operator from "./operator.ts";
import * as stuck from "./stuck.ts";
import { actionsOf as releasesOf } from "../../operator-actions.ts";
import { verificationOf } from "../../verify/results.ts";
import { areaNameOf } from "../../areas/store.ts";
import { settledOf, unflagged } from "../../classify/settled.ts";
import { isQuiet } from "../../security/quiet.ts";
import { classificationsOf, itemState, relatedOf } from "./decisions.ts";
import * as sim from "./similar.ts";
import * as inference from "./inference.ts";
import { inferenceMode } from "../../remote/mode.ts";
import { fixes as needsFixes, needs } from "./needs.ts";
import { home } from "./home.ts";
import { localEmbedder, type Embedder } from "../../embed/model.ts";
import type { Exec } from "../../fixup/git.ts";
import { batchOne } from "./batch-page.ts";
import { batchRemovePr, batchStop, fastTrackAdd, fastTrackRefs, fastTrackRemove, fastTrackWeight, queueAdd, heldMergeRefs, mergeHoldPr, pipelineRepoNames, queuePage } from "./queue-page.ts";
import { VectorIndex } from "../../embed/vectors.ts";
import { mainCiRepos, summarize } from "../../mainci/index.ts";
import type { Db } from "../../db/index.ts";

export type ApiOptions = {
  // Opinions and comments by non-operators, per login per hour.
  writesPerHour?: number;
  // The limiter itself, when the Inbox MCP server's feedback must share it (see AppOptions.feedbackLimiter); overrides writesPerHour.
  limiter?: RateLimiter;
  // Embeds search queries and items without a stored vector; default: the local model, loaded on first use.
  embedder?: Embedder;
  // Runs `gh` for the batch controls that close a PR; default: the real one. Tests fake it.
  exec?: Exec;
  // Looks up a login's numeric GitHub id when an access entry is added; default: GitHub's API. Tests fake it.
  githubUserId?: adm.GithubUserLookup;
};

const ok = (fn: (db: Db, req: Req) => Promise<unknown>) => async (db: Db, req: Req): Promise<Res> => {
  try {
    const v = await fn(db, req);
    return v === undefined ? { status: 204 } : { json: v };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, json: { error: e.message } };
    throw e;
  }
};

async function writeRepos(db: Db, req: Req): Promise<string[]> {
  const repos = await allVisibleRepos(db, req);
  const ok = await Promise.all(repos.map((r) => req.user.canWrite(r).catch(() => false)));
  return repos.filter((_, i) => ok[i]);
}

/** The visible repos this user runs (src/dash/repo-access.ts): the web reads it instead of the role for per-repo and per-item actions. */
async function runRepos(db: Db, req: Req): Promise<string[]> {
  const repos = await allVisibleRepos(db, req);
  const ok = await Promise.all(repos.map((r) => mayRunRepo(req.user, r)));
  return repos.filter((_, i) => ok[i]);
}

async function me(db: Db, req: Req): Promise<User> {
  const mw = await db.get(db.k.selectFrom("settings").select("value").where("key", "=", "maintainer_writes"));
  return {
    login: req.user.login,
    role: req.user.role,
    writeRepos: await writeRepos(db, req),
    runRepos: await runRepos(db, req),
    maintainerWrites: mw?.value === "1",
    maintainerSettles: await maintainersSettle(db),
    inference: await inferenceMode(db),
  };
}

// ---- items and search ------------------------------------------------------

const CI: Record<string, CiState> = { SUCCESS: "passing", FAILURE: "failing", ERROR: "failing", PENDING: "pending", EXPECTED: "pending" };
const MERGEABLE: Record<string, Mergeable> = { MERGEABLE: "clean", CONFLICTING: "conflicts" };
const TIER: Record<string, Tier> = { whitelisted: "whitelisted", not: "not", allow: "override-allow", deny: "override-deny" };

export async function itemCore(db: Db, req: Req): Promise<Item> {
  const repo = req.params.repo!;
  const n = Number(req.params.n);
  if (!Number.isInteger(n)) throw new HttpError(400, "not an item number");
  // The visibility check decides first: an item of a hidden repo is a 404 for its repo whether or not the mirror has it.
  const [, it] = await Promise.all([needVisible(db, req, repo), db.get(db.k.selectFrom("items").select(kx.cols("items")).where("repo", "=", repo).where("number", "=", n))]);
  if (!it) throw new HttpError(404, `no item ${repo}#${n} in the mirror`);
  let labels: string[] = [];
  try {
    const l = JSON.parse(it.labels ?? "[]") as unknown;
    if (Array.isArray(l)) labels = l.filter((x): x is string => typeof x === "string");
  } catch { /* malformed: no labels */ }
  const internals = canSeeInternals(req);
  const pr = it.kind === "pr";
  // The parts read independently, so they run together.
  const [c, stages, comments, decisionIds, quiet, files, ciChecks, tracked, related, classifications, area, discordOf, settled, priority, work, checks, reviews, premerge, postmerge, actions, releases, slots, preapproval] = await Promise.all([
    it.author ? contributors(db, { login: it.author }).then((cs) => cs.find((x) => x.login === it.author)) : undefined,
    db.all(db.k.selectFrom("stages").select(["stage", "at", "actor as by", "note"]).where("repo", "=", repo).where("number", "=", n)
      .orderBy("at").orderBy(kx.rowid("stages")).$narrowType<{ stage: Item["stages"][number]["stage"] }>()),
    db.all(db.k.selectFrom("comments").select(["id", "author", "created_at as at", "body", "kind", "review_state as reviewState"])
      .where("repo", "=", repo).where("number", "=", n)
      .where((eb) => eb.not(eb.and([eb("kind", "=", "review"), eb(eb.fn.coalesce(eb.fn("trim", ["body"]), eb.val("")), "=", "")])))
      .orderBy("created_at", (o) => o.asc().nullsFirst()).orderBy(kx.rowid("comments")).$narrowType<{ kind: ItemComment["kind"] | null }>()),
    db.all(db.k.selectFrom("decisions").select("id").where((eb) => eb.or([
      eb.and([eb("repo", "=", repo), eb("number", "=", n)]),
      eb.and([eb("number", "is", null), eb.exists(
        db.k.selectFrom(kx.jsonEach(db, eb.case().when(kx.jsonValid(db, "items")).then(eb.ref("items")).else("[]").end(), "j")).select(eb.lit(1).as("one"))
          .where((e) => e.and([e(kx.jsonText(db, "j.value", "$.repo"), "=", repo), e(kx.jsonNum(db, "j.value", "$.number"), "=", n)])))]),
    ])).orderBy("asked_at")).then((rows) => rows.map((r) => r.id)),
    isQuiet(db, repo, n),
    pr ? filesOf(db, repo, n) : [], pr ? ciChecksOf(db, repo, n) : [],
    db.get(db.k.selectFrom("tracked_repos").select("pipeline").where("name", "=", repo)),
    relatedOf(db, repo, n), classificationsOf(db, repo, n), areaNameOf(db, repo, n), discord.discordOf(db, repo, n), settledOf(db, repo, n), priorityOf(db, repo, n),
    pr ? prWork(db, repo, n, internals) : { verification: null, fixups: [], prBuild: null },
    checksOf(db, repo, n),
    pr ? hiddenRepos(db, req).then((hidden) => reviewsOf(db, repo, n, internals, hidden)) : null,
    pr ? premergeOf(db, repo, n) : [], pr ? postmergeOf(db, repo, n, internals) : null,
    actionsOf(db, repo, n), releasesOf(db, repo, n),
    visibleRepos(db, req).then((v) => queueSlots(db, v)),
    pr ? preapprovalOf(db, repo, n) : null,
  ]);
  // The quiet pull request of a security fix: viewers get none of the model text about it.
  const veil = !internals && quiet;
  const out: Item = {
    repo, number: n, kind: it.kind === "pr" ? "pr" : "issue",
    title: it.title ?? "", body: it.body ?? "", state: itemState(it.state), author: it.author ?? "",
    tier: TIER[c?.tier ?? "not"] ?? "not", authorMerged: c?.merged ?? 0, authorClosedUnmerged: c?.closed ?? 0,
    additions: it.additions ?? 0, deletions: it.deletions ?? 0,
    changedFiles: it.kind === "pr" ? it.changed_files : null,
    // Per-check states of the head come from pr_checks and per-file rows from pr_files (src/activity.ts).
    files, ciChecks,
    ci: it.kind === "pr" ? (CI[it.ci_state ?? ""] ?? "none") : "none",
    mergeable: MERGEABLE[it.mergeable ?? ""] ?? "unknown",
    labels, createdAt: it.created_at ?? "", updatedAt: it.updated_at ?? "",
    closedAt: it.closed_at, mergedAt: it.merged_at, mergedBy: it.merged_by,
    pipelineOn: tracked?.pipeline === 1,
    related, classifications, area,
    // Stage notes quote review reasons, verification summaries and fix-up reasons: staff only.
    stages: stages.map((s) => ({ ...s, by: s.by ?? "", note: internals ? s.note : null })),
    discord: discordOf,
    comments: comments.map((x) => ({ ...x, author: x.author ?? "", body: x.body ?? "" })),
    decisionIds, settled: unflagged(settled, quiet, !veil) as Item["settled"], priority,
    ...work,
    // The reviewer's reasons quote the patch, so viewers get the verdict only.
    patchChecks: checks.map(({ kind, subject, patchHash, round, verdict, reasons, problems, model, createdAt }) =>
      ({ kind, subject, patchHash, round, verdict, reasons: internals ? reasons : "", problems: internals ? problems : [], model, createdAt })),
    reviews,
    premerge,
    postmerge,
    actions, releases,
    queue: slots.get(`${repo}#${n}`) ?? null,
    // The operator's instructions are shown to those who see the internals only.
    ...(pr ? { preapproval: preapproval && !internals ? { ...preapproval, instructions: "" } : preapproval } : {}),
  };
  if (!veil) return out;
  return {
    ...out,
    classifications: out.classifications.map((c) => ({ ...c, reason: "" })),
    priority: out.priority && { ...out.priority, reason: null },
    premerge: out.premerge?.map((p) => ({ ...p, findings: [] })),
    reviews: out.reviews && { ...out.reviews, conflicts: out.reviews.conflicts.map((c) => ({ ...c, reason: "" })) },
  };
}

/** The changed files the activity sync stored for the current head; empty until the sync has read the PR. */
async function filesOf(db: Db, repo: string, n: number): Promise<Item["files"]> {
  return db.all(db.k.selectFrom("pr_files as f")
    .innerJoin("items as i", (j) => j.onRef("i.repo", "=", "f.repo").onRef("i.number", "=", "f.number").onRef("i.head_oid", "=", "f.head"))
    .select(["f.path", "f.additions", "f.deletions"]).where("f.repo", "=", repo).where("f.number", "=", n).orderBy("f.path"));
}

/** The head's check contexts as the checks sync stored them; empty when they belong to an older head. */
async function ciChecksOf(db: Db, repo: string, n: number): Promise<Item["ciChecks"]> {
  const r = await db.get(db.k.selectFrom("pr_checks as c").innerJoin("items as i", (j) => j.onRef("i.repo", "=", "c.repo").onRef("i.number", "=", "c.number"))
    .select("c.checks").where("c.repo", "=", repo).where("c.number", "=", n)
    .where((eb) => eb.or([eb("i.head_oid", "is", null), eb("i.head_oid", "=", eb.ref("c.head_oid"))])));
  if (!r) return [];
  let list: unknown = [];
  try { list = JSON.parse(r.checks); } catch { /* malformed: none */ }
  return (Array.isArray(list) ? (list as ({ name?: unknown; state?: unknown } | null)[]) : []).flatMap((c) =>
    c && typeof c.name === "string" ? [{ name: c.name, state: CI[typeof c.state === "string" ? c.state.toUpperCase() : ""] ?? "none", minutes: null }] : []);
}

/** Pre-merge review rows of the PR, newest first. */
async function premergeOf(db: Db, repo: string, n: number): Promise<ItemPremerge[]> {
  const rows: PremergeRow[] = await db.all(db.k.selectFrom("premerge_reviews").select(kx.cols("premerge_reviews")).where("repo", "=", repo).where("number", "=", n)
    .orderBy("at", "desc").orderBy("head_oid", "desc"));
  return rows.map((r) => ({ head: r.head_oid, at: r.at, model: r.model, findings: findingsOf(r), searched: r.searched, error: r.error, tries: r.tries }));
}

/** The Opus review of the newest reviewed head, which is also the final verdict. */
/**
 * The owner statements the Opus or the pre-merge review at the head named as conflicts, with the reviews' reasons and the item each
 * was said about. A statement made in a repo hidden from the reader is left out; viewers (`internals` false) get no excerpt or reason.
 */
async function conflictsNamed(db: Db, repo: string, n: number, head: string, internals: boolean, hidden: HiddenRepos): Promise<ItemReviews["conflicts"]> {
  const stored = [
    (await db.get(db.k.selectFrom("opus_reviews").select("conflicts").where("repo", "=", repo).where("number", "=", n).where("head_oid", "=", head)))?.conflicts,
    (await db.get(db.k.selectFrom("premerge_reviews").select("conflicts").where("repo", "=", repo).where("number", "=", n).where("head_oid", "=", head)))?.conflicts,
  ];
  const out: ItemReviews["conflicts"] = [];
  for (const raw of stored) {
    let v: unknown = [];
    try { v = JSON.parse(raw ?? "[]"); } catch { /* unreadable: none */ }
    for (const h of Array.isArray(v) ? (v as { id?: unknown; reason?: unknown }[]) : []) {
      if (typeof h?.id !== "number" || out.some((d) => d.id === h.id)) continue;
      const d = await db.get(db.k.selectFrom("owner_statements as s").leftJoin("items as i", (j) => j.onRef("i.repo", "=", "s.repo").onRef("i.number", "=", "s.number"))
        .select(["s.repo", "s.number", "s.text", "s.item_title", "i.kind", "i.state", "i.title"]).where("s.id", "=", h.id)
        .$narrowType<{ kind: "pr" | "issue" | null }>());
      if (!d || isHiddenRepo(hidden, d.repo)) continue;
      out.push({
        id: h.id, repo: d.repo, number: d.number, kind: d.kind, state: d.state ? (d.state.toLowerCase() as ItemState) : null, title: d.title ?? (d.item_title || null),
        excerpt: internals ? d.text.replace(/\s+/g, " ").trim().slice(0, 200) : "", reason: internals && typeof h.reason === "string" ? h.reason : "",
      });
    }
  }
  return out.sort((a, b) => a.id - b.id);
}

/** `internals` false (viewers): the verdict only; the reviewer's reason, fixes and risks quote the patch. */
async function reviewsOf(db: Db, repo: string, n: number, internals: boolean, hidden: HiddenRepos): Promise<ItemReviews | null> {
  // The view holds the rows of opus_reviews that have a verdict; its head, time and mode columns are NOT NULL there.
  const o = await db.get(db.k.selectFrom("final_reviews").select(["head_oid", "at", "mode", "base_head", "verdict", "sure", "reason", "fixes", "risks"])
    .where("repo", "=", repo).where("number", "=", n).orderBy("at", "desc").orderBy("head_oid", "desc").limit(1)
    .$narrowType<{ head_oid: string; at: string; mode: "full" | "delta"; verdict: ReviewSide["verdict"] }>());
  if (!o) return null;
  const list = <T>(s: string | null): T[] => { try { const v = JSON.parse(s ?? "[]") as unknown; return Array.isArray(v) ? (v as T[]) : []; } catch { return []; } };
  const head = (await db.get(db.k.selectFrom("items").select("head_oid").where("repo", "=", repo).where("number", "=", n)))?.head_oid ?? null;
  return {
    head: o.head_oid, current: o.head_oid === head, conflicts: await conflictsNamed(db, repo, n, o.head_oid, internals, hidden),
    opus: { verdict: o.verdict, reason: internals ? o.reason ?? "" : "", fixes: internals ? list(o.fixes) : [], risks: internals ? list(o.risks) : [], at: o.at, sure: o.sure === 1, mode: o.mode, baseHead: o.base_head },
    final: { verdict: o.verdict, reason: internals ? o.reason ?? "" : "", decided: true },
  };
}

/** `internals` false (viewers): states only, without job errors or model output. */
async function prWork(db: Db, repo: string, n: number, internals: boolean): Promise<Pick<Item, "verification" | "fixups" | "prBuild">> {
  const head = (await db.get(db.k.selectFrom("items").select("head_oid").where("repo", "=", repo).where("number", "=", n)))?.head_oid ?? null;
  const latest = await db.get(db.k.selectFrom("verifications").select("head_sha").where("repo", "=", repo).where("number", "=", n)
    .$if(head !== null, (q) => q.orderBy((eb) => eb("head_sha", "=", head!), "desc")).orderBy("created_at", "desc").limit(1));
  const v = latest ? await verificationOf(db, repo, n, latest.head_sha) : null;
  const plan = (v?.plan ?? null) as Record<string, unknown> | null;
  const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
  const fixups = (await db.all(db.k.selectFrom("fixups").select(["from_head", "to_head", "state", "reason", "files", "attempt", "created_at"])
    .where("repo", "=", repo).where("number", "=", n).orderBy("created_at").orderBy(kx.rowid("fixups"))))
    .map((f): ItemFixup => {
      let files: string[] = [];
      try { files = strings(JSON.parse(f.files ?? "[]")); } catch { /* malformed: none */ }
      return { fromHead: f.from_head, toHead: f.to_head, state: f.state as ItemFixup["state"], reason: internals ? f.reason : null, files: internals ? files : [], attempt: f.attempt, createdAt: f.created_at };
    });
  // CI fix tries are listed with the fix-ups, oldest first.
  const ciFixes = (await db.all(db.k.selectFrom("ci_fixes").select(["head", "to_head", "state", "reason", "files", "attempt", "created_at"])
    .where("repo", "=", repo).where("number", "=", n).orderBy("created_at").orderBy(kx.rowid("ci_fixes"))))
    .map((f): ItemFixup => {
      let files: string[] = [];
      try { files = strings(JSON.parse(f.files ?? "[]")); } catch { /* malformed: none */ }
      return { kind: "ci-fix", fromHead: f.head, toHead: f.to_head, state: f.state as ItemFixup["state"], reason: internals ? f.reason : null, files: internals ? files : [], attempt: f.attempt, createdAt: f.created_at };
    });
  fixups.push(...ciFixes);
  fixups.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    fixups,
    prBuild: await prBuildView(db, repo, n, head, internals),
    verification: !v ? null : {
      headSha: v.headSha, baseSha: v.baseSha, current: v.headSha === head, kind: v.kind as ItemVerification["kind"], reason: internals ? v.reason : "",
      plan: !plan ? null : { crates: plan.crate ? [String(plan.crate)] : strings(plan.crates), tests: strings(plan.tests), testLines: typeof plan.test_lines === "number" ? plan.test_lines : null },
      state: v.state, summary: internals ? v.summary : null, note: internals ? v.note : null, createdAt: v.createdAt, finishedAt: v.finishedAt,
      tasks: v.tasks.map((t) => ({ id: t.id, role: t.role, state: t.state, results: internals ? t.results : [], endedAt: t.endedAt })),
    },
  };
}

async function actionsOf(db: Db, repo: string, n: number): Promise<ItemAction[]> {
  return (await db.all(db.k.selectFrom("actions").select(["decision_id", "kind", "state", "comment_url", "reason", "created_at"])
    .select((eb) => eb.selectFrom("decisions as d").select("d.kind").whereRef("d.id", "=", "actions.decision_id").limit(1).as("decision_kind"))
    .where("repo", "=", repo).where("number", "=", n).orderBy("created_at").orderBy("id")))
    .map((a): ItemAction => ({ decisionId: a.decision_id, decisionKind: a.decision_kind as DecisionKind | null, kind: a.kind, state: a.state as ItemAction["state"], commentUrl: a.comment_url, reason: a.reason, createdAt: a.created_at }));
}

// ---- progress ----------------------------------------------------------------

const toFunnel = (r: FunnelRow | undefined): Funnel => ({
  open: r?.open ?? 0, classified: r?.classified ?? 0, secondOpinion: r?.second_opinion ?? 0, disagreement: r?.disagreement ?? 0, reviewed: r?.reviewed ?? 0, take: r?.take ?? 0,
  hold: r?.hold ?? 0, close: r?.close ?? 0, waiting: r?.needs_decision ?? 0, batched: r?.batched ?? 0,
});
const toDone = (r: DoneRow | undefined): Done => ({
  mergedByPipeline: r?.merged_pipeline ?? 0, closedByPipeline: r?.closed_pipeline ?? 0, closedByOthers: r?.closed_others ?? 0,
});
const sum = <T extends object>(xs: T[], zero: T): T => {
  const out = { ...zero } as Record<string, number>;
  for (const x of xs) for (const [k, v] of Object.entries(x)) out[k] = (out[k] ?? 0) + (v as number);
  return out as T;
};

type Heavy = Omit<Progress, "decisionsOpen" | "decisionsAnsweredToday" | "mainCi">;
// One entry per set of hidden repos (nearly always the operator's empty set and one other).
const progressCache = new WeakMap<Db, Map<string, { key: string; at: number; value: Heavy }>>();
const PROGRESS_MAX_AGE = 60_000;

// The item-based part of Progress: scans most of the mirror, so it is kept until
// the mirror, the stages or the tracked repos change, or for a minute at most
// (classifier verdicts and the hourly counts show within that minute).
async function progressItems(db: Db, hidden: HiddenRepos): Promise<Heavy> {
  const sig = await db.get(db.k.selectNoFrom((eb) => [
    eb.selectFrom("main.repos").select((e) => e.fn.max<string | null>("synced_at").as("m")).as("synced"),
    eb.selectFrom("main.settings").select("value").where("key", "=", "org_high_water").as("hw"),
    eb.selectFrom("main.stages").select((e) => e.fn.countAll<number>().as("c")).as("st_count"),
    eb.selectFrom("main.stages").select((e) => e.fn.max<number | null>(kx.rowid("main.stages")).as("m")).as("st_max"),
    eb.selectFrom("main.tracked_repos").select(kx.groupConcat(db, "name", ",", "name").as("g")).as("tr"),
  ]));
  const key = JSON.stringify(sig);
  const cache = progressCache.get(db) ?? progressCache.set(db, new Map()).get(db)!;
  const slot = JSON.stringify([hidden, hidden.visible ?? null]);
  const hit = cache.get(slot);
  if (hit && hit.key === key && Date.now() - hit.at < PROGRESS_MAX_AGE) return hit.value;
  const start = await trackingStart(db);
  const now = Date.now();
  const funnels = new Map((await funnelByRepo(db)).filter((r) => !isHiddenRepo(hidden, r.repo)).map((r) => [r.repo, r]));
  const done = new Map((await doneByRepo(db, start)).filter((r) => !isHiddenRepo(hidden, r.repo)).map((r) => [r.repo, r]));
  const perHour = new Array<number>(24).fill(0);
  const perHourPipeline = new Array<number>(24).fill(0);
  const since = now - 24 * 3600_000;
  for (const r of await db.all(latestCteExpr(db).selectFrom("main.items as i")
    .leftJoin("latest as l", (j) => j.onRef("l.repo", "=", "i.repo").onRef("l.number", "=", "i.number"))
    .select((eb) => ["i.closed_at", eb("l.stage", "in", ["merged", "closed", "fixed-by-us"]).as("ours")])
    .where("i.closed_at", ">=", new Date(since).toISOString()).where("i.state", "<>", "OPEN")
    .where((eb) => trackedExpr(db, eb, "i.repo"))
    .where((eb) => excludeHiddenExpr(db, "i.repo", hidden) ?? eb.lit(true))
    .$narrowType<{ closed_at: string }>())) {
    const h = Math.floor((Date.parse(r.closed_at) - since) / 3600_000);
    if (h >= 0 && h < 24) {
      perHour[h]!++;
      if (r.ours) perHourPipeline[h]!++;
    }
  }
  const names = [...new Set([...await trackedNames(db), ...funnels.keys(), ...done.keys()])].filter((n) => !isHiddenRepo(hidden, n)).sort();
  const { series } = await trend(db, start, new Map(names.map((n) => [n, funnels.get(n)?.open ?? 0])));
  const repos: RepoProgress[] = names.map((repo) => ({
    repo, funnel: toFunnel(funnels.get(repo)), done: toDone(done.get(repo)),
    decisionsOpen: 0, openTrend: series.get(repo)!,
  }));
  const value: Heavy = {
    trackingSince: start, now: new Date(now).toISOString(),
    funnel: sum(repos.map((r) => r.funnel), toFunnel(undefined)),
    done: sum(repos.map((r) => r.done), toDone(undefined)),
    perHour, perHourPipeline, repos,
  };
  cache.set(slot, { key, at: now, value });
  if (cache.size > 8) cache.delete(cache.keys().next().value!);
  return value;
}

async function progress(db: Db, hidden: HiddenRepos): Promise<Progress> {
  const heavy = await progressItems(db, hidden);
  const openDec = new Map<string, number>();
  let decisionsOpen = 0;
  for (const r of await db.all(db.k.selectFrom("decisions").select(["repo", "number", "items"]).where("answer", "is", null)
    .where((eb) => withoutHiddenExpr(db, eb, hidden) ?? eb.lit(true)))) {
    decisionsOpen++;
    let repos = r.number !== null && r.repo ? [r.repo] : [];
    if (r.number === null) {
      try {
        repos = [...new Set((JSON.parse(r.items ?? "[]") as { repo: string }[]).map((x) => x.repo))];
      } catch { /* malformed batch: counted for no repo */ }
    }
    for (const x of repos) openDec.set(x, (openDec.get(x) ?? 0) + 1);
  }
  const today = new Date().toISOString().slice(0, 10);
  const answeredToday = (await db.get(db.k.selectFrom("decisions").select((eb) => eb.fn.countAll<number>().as("n")).where("answered_at", ">=", `${today}T00:00:00`)
    .where((eb) => withoutHiddenExpr(db, eb, hidden) ?? eb.lit(true))))!.n;
  return {
    ...heavy,
    repos: heavy.repos.map((r) => ({ ...r, decisionsOpen: openDec.get(r.repo) ?? 0 })),
    decisionsOpen, decisionsAnsweredToday: answeredToday,
    mainCi: summarize(await mainCiRepos(db, hidden)),
  };
}

// ---- routes --------------------------------------------------------------

export function apiRoutes(opts: ApiOptions = {}): Route[] {
  const limiter = opts.limiter ?? new RateLimiter(share(opts.writesPerHour ?? 60), 3600_000);
  const vectors = new VectorIndex(opts.embedder ?? localEmbedder({ threads: 2 }));
  const get = (pattern: string, fn: (db: Db, req: Req) => Promise<unknown>): Route => ({ method: "GET", pattern, handler: ok(fn) });
  const post = (pattern: string, fn: (db: Db, req: Req) => Promise<unknown>): Route => ({ method: "POST", pattern, handler: ok(fn) });
  const heavy = (r: Route, when?: (q: URLSearchParams) => boolean): Route => ({ ...r, expensive: when ?? true });
  // The lists the web app's project picker narrows; pages reached by their own link, writes, search and settings see every repo.
  const scoped = (r: Route): Route => ({ ...r, scoped: true });
  return [
    get("/api/me", me),
    get("/api/repos", allVisibleRepos),
    get("/api/repos/owners", repoOwners),
    scoped(get("/api/decisions", async (db, req) => dec.listDecisions(db, req))),
    get("/api/decisions/open-counts", dec.openCounts),
    get("/api/decisions/:id", dec.getOne),
    get("/api/decisions/:id/thread", dec.thread),
    post("/api/decisions/:id/answer", dec.answer),
    post("/api/decisions/:id/undo", dec.undo),
    post("/api/decisions/:id/retry", dec.retry),
    post("/api/decisions/:id/dispute", dec.dispute),
    post("/api/decisions/:id/keep", dec.keepAnswer),
    { method: "POST", pattern: "/api/decisions/:id/snooze", handler: ok(dec.snooze) },
    { method: "POST", pattern: "/api/decisions/:id/reprepare", handler: ok(dec.reprepare) },
    post("/api/decisions/:id/reopen", dec.reopen),
    post("/api/items/:repo/:n/backlog", dec.backlogItemRoute),
    { method: "POST", pattern: "/api/decisions/backlog", handler: ok(dec.backlogBulk) },
    post("/api/decisions/:id/adopt", dec.adopt),
    post("/api/decisions/:id/feedback", async (db, req) => dec.feedback(db, req, limiter)),
    post("/api/decisions/:id/retract", async (db, req) => dec.retract(db, req, limiter)),
    post("/api/decisions/:id/claim", dec.claim),
    get("/api/mcp/tokens", mcp.tokens),
    post("/api/mcp/tokens", mcp.create),
    post("/api/mcp/tokens/revoke", mcp.revoke),
    get("/api/me/settings", userSettings.settings),
    { method: "PUT", pattern: "/api/me/settings", handler: ok(userSettings.setSettings) },
    get("/api/runners", runners.list),
    get("/api/runners/pending", runners.pending),
    post("/api/runners/approve", runners.approve),
    post("/api/runners/deny", runners.deny),
    post("/api/runners/revoke", runners.revoke),
    post("/api/runners/scopes", runners.scopes),
    get("/api/model-queue", modelQueue.get),
    post("/api/model-queue/:id/pick", modelQueue.pick),
    post("/api/model-queue/:id/unpick", modelQueue.unpick),
    get("/api/items/:repo/:n", itemCore),
    get("/api/items/:repo/:n/page", itemPage),
    get("/api/items/:repo/:n/peek", items.peek),
    scoped(get("/api/activity", activity)),
    get("/api/downloads", downloads),
    get("/api/items/:repo/:n/trace", itemTrace),
    get("/api/items/:repo/:n/trace/event", itemTraceDetail),
    get("/api/items/:repo/:n/decision", dec.forItem),
    get("/api/conversations/:repo/:n", conv.getConversation),
    { method: "POST", pattern: "/api/conversations/:repo/:n/messages", handler: ok(async (db, req) => conv.postMessage(db, req)) },
    { method: "POST", pattern: "/api/conversations/:repo/:n/withdraw", handler: ok(async (db, req) => conv.postWithdraw(db, req)) },
    { method: "POST", pattern: "/api/conversations/:repo/:n/includes", handler: ok(async (db, req) => conv.postInclude(db, req)) },
    { method: "POST", pattern: "/api/conversation-cards/:id/edit", handler: ok(conv.editCardText) },
    { method: "POST", pattern: "/api/conversation-cards/:id/do", handler: ok(async (db, req) => conv.doIt(db, req)) },
    { method: "POST", pattern: "/api/conversation-cards/:id/dismiss", handler: ok(conv.dismiss) },
    { method: "POST", pattern: "/api/conversation-cards/:id/dispute", handler: ok(conv.disputePress) },
    { method: "POST", pattern: "/api/conversation-cards/:id/keep", handler: ok(conv.keepPress) },
    { method: "POST", pattern: "/api/decision-choices/:id/do", handler: ok(async (db, req) => conv.doChoice(db, req)) },
    { method: "POST", pattern: "/api/items/:repo/:n/preapproval/cancel", handler: ok(operator.cancelItemPreapproval) },
    { method: "POST", pattern: "/api/items/:repo/:n/preapproval/retry", handler: ok(operator.retryItemPreapproval) },
    { method: "POST", pattern: "/api/items/:repo/:n/review-again", handler: ok(operator.reviewItemAgain) },
    { method: "POST", pattern: "/api/items/:repo/:n/verify-again", handler: ok(operator.verifyItemAgain) },
    { method: "POST", pattern: "/api/items/:repo/:n/stop-fix", handler: ok(operator.stopFixItem) },
    get("/api/areas/:repo", areas.repoAreas),
    { method: "POST", pattern: "/api/areas/:repo/edit", handler: ok(areas.edit) },
    { method: "POST", pattern: "/api/areas/:repo/run", handler: ok(areas.run) },
    { method: "POST", pattern: "/api/area-proposals/:id/accept", handler: ok(areas.acceptProposalApi) },
    { method: "POST", pattern: "/api/area-proposals/:id/dismiss", handler: ok(areas.dismiss) },
    { method: "POST", pattern: "/api/items/:repo/:n/batch-again", handler: ok(operator.batchItemAgain) },
    scoped(get("/api/items", items.listItems)),
    heavy(get("/api/search", async (db, req) => req.query.get("mode") === "semantic" ? sim.semanticSearch(db, req, vectors) : items.quickSearch(db, req)), (q) => q.get("mode") === "semantic"),
    get("/api/progress", async (db, req) => await progress(db, await hiddenRepos(db, req))),
    get("/api/main-ci", async (db, req) => {
      const repos = await mainCiRepos(db, await hiddenRepos(db, req));
      return { summary: summarize(repos), repos };
    }),
    get("/api/stuck", stuck.stuckItems),
    get("/api/main-ci/summary", async (db, req) => summarize(await mainCiRepos(db, await hiddenRepos(db, req)))),
    heavy(get("/api/contributors", adm.listContributors)),
    heavy(get("/api/contributors/rule-preview", adm.previewRule)),
    post("/api/contributors/rule", adm.saveRule),
    post("/api/contributors/:login/override", async (db, req) => adm.override(db, req, opts.githubUserId ?? githubUserId)),
    get("/api/repos/all", adm.allRepos),
    post("/api/repos/track", async (db, req) => adm.track(db, req, true)),
    post("/api/repos/untrack", async (db, req) => adm.track(db, req, false)),
    post("/api/repos/labels-approve", async (db, req) => await adm.labelsApproval(db, req, true)),
    post("/api/repos/labels-revoke", async (db, req) => await adm.labelsApproval(db, req, false)),
    post("/api/repos/merge-approve", async (db, req) => await adm.mergeApproval(db, req, true)),
    post("/api/repos/merge-revoke", async (db, req) => await adm.mergeApproval(db, req, false)),
    post("/api/repos/ci-approve", async (db, req) => await adm.ciApproval(db, req, true)),
    post("/api/repos/ci-revoke", async (db, req) => await adm.ciApproval(db, req, false)),
    get("/api/sandbox/workspace", adm.workspaceInfo),
    { method: "GET", pattern: "/api/admin/discord", operator: true, handler: ok(discord.setup) },
    { method: "PUT", pattern: "/api/admin/discord/channel", operator: true, handler: ok(discord.putChannel) },
    { method: "PUT", pattern: "/api/admin/discord/channel-repo", operator: true, handler: ok(discord.putChannelRepo) },
    { method: "POST", pattern: "/api/admin/discord/unlink", operator: true, handler: ok(discord.removeLink) },
    get("/api/account/discord", discord.account),
    post("/api/account/discord/unlink", discord.unlinkOwn),
    post("/api/account/discord/code", discord.linkCode),
    { method: "PUT", pattern: "/api/admin/discord/contact", operator: true, handler: ok(discord.putContact) },
    { method: "PUT", pattern: "/api/admin/discord/react", operator: true, handler: ok(discord.putReact) },
    { method: "PUT", pattern: "/api/sandbox/workspace", operator: true, handler: ok(adm.setWorkspaceInfo) },
    get("/api/merge/single", adm.singleMerge),
    { method: "PUT", pattern: "/api/merge/single", operator: true, handler: ok(adm.setSingleMerge) },
    { method: "GET", pattern: "/api/settings/inference", operator: true, handler: ok(inference.get) },
    { method: "PUT", pattern: "/api/settings/inference", operator: true, handler: ok(inference.put) },
    post("/api/repos/comment-approve", async (db, req) => await adm.commentApproval(db, req, true)),
    post("/api/repos/comment-revoke", async (db, req) => await adm.commentApproval(db, req, false)),
    post("/api/repos/push-approve", async (db, req) => await adm.pushApproval(db, req, true)),
    post("/api/repos/push-revoke", async (db, req) => await adm.pushApproval(db, req, false)),
    post("/api/repos/fixissue-approve", async (db, req) => await adm.fixIssueApproval(db, req, true)),
    post("/api/repos/fixissue-revoke", async (db, req) => await adm.fixIssueApproval(db, req, false)),
    post("/api/repos/prstatus-approve", async (db, req) => await adm.statusApproval(db, req, true)),
    post("/api/repos/prstatus-revoke", async (db, req) => await adm.statusApproval(db, req, false)),
    post("/api/repos/mainfix-approve", async (db, req) => await adm.mainFixApproval(db, req, true)),
    post("/api/repos/mainfix-revoke", async (db, req) => await adm.mainFixApproval(db, req, false)),
    post("/api/repos/optional-check-add", async (db, req) => await adm.optionalCheck(db, req, true)),
    post("/api/repos/optional-check-remove", async (db, req) => await adm.optionalCheck(db, req, false)),
    post("/api/repos/pipeline-on", async (db, req) => await adm.pipelineSwitch(db, req, true)),
    post("/api/repos/pipeline-off", async (db, req) => await adm.pipelineSwitch(db, req, false)),
    post("/api/repos/build-feature", adm.buildFeatureSwitch),
    { method: "GET", pattern: "/api/access", operator: true, handler: ok(adm.accessOverview) },
    { method: "POST", pattern: "/api/access/add", operator: true, handler: ok(async (db, req) => adm.accessAdd(db, req, opts.githubUserId ?? githubUserId)) },
    { method: "POST", pattern: "/api/access/remove", operator: true, handler: ok(adm.accessRemove) },
    { method: "POST", pattern: "/api/access/role", operator: true, handler: ok(adm.accessRole) },
    { method: "POST", pattern: "/api/access/sessions/revoke", operator: true, handler: ok(adm.revokeSession) },
    { method: "POST", pattern: "/api/access/tokens/revoke", operator: true, handler: ok(adm.revokeAgentToken) },
    get("/api/audit", adm.auditLog),
    get("/api/classifiers", insight.classifiersReport),
    get("/api/classifiers/disagreements", insight.disagreements),
    get("/api/cost", insight.cost),
    get("/api/pipeline", pipeline.overview),
    get("/api/pipeline/jobs", pipeline.jobs),
    get("/api/pipeline/jobs/:id", pipeline.job),
    { method: "POST", pattern: "/api/pipeline/jobs", operator: true, handler: ok(pipeline.request) },
    { method: "POST", pattern: "/api/pipeline/jobs/:id/cancel", handler: ok(pipeline.cancel) },
    get("/api/pipeline/state", pipeline.state),
    { method: "PUT", pattern: "/api/pipeline/state", operator: true, handler: ok(pipeline.putState) },
    { method: "GET", pattern: "/api/pipeline/judgement-model", operator: true, handler: ok(async (db) => await pipeline.getJudgementModel(db)) },
    { method: "PUT", pattern: "/api/pipeline/judgement-model", operator: true, handler: ok(pipeline.putJudgementModel) },
    { method: "PUT", pattern: "/api/pipeline/limits/:step", operator: true, handler: ok(pipeline.putLimit) },
    { method: "POST", pattern: "/api/pipeline/limits/:step/reset", operator: true, handler: ok(pipeline.resetLimit) },
    { method: "POST", pattern: "/api/pipeline/steps/:step/deadline-ack", operator: true, handler: ok(pipeline.ackStepDeadline) },
    { method: "POST", pattern: "/api/pipeline/trips/:stage/resume", handler: ok(pipeline.resumeTrip) },
    { method: "PUT", pattern: "/api/pipeline/pilot", operator: true, handler: ok(adm.putPilot) },
    { method: "PUT", pattern: "/api/pipeline/outside-limits", operator: true, handler: ok(outside.putLimits) },
    { method: "POST", pattern: "/api/pipeline/outside/release", operator: true, handler: ok(outside.releaseAll) },
    { method: "POST", pattern: "/api/items/:repo/:n/release-outside", handler: ok(outside.release) },
    scoped(get("/api/needs/outside/:author", outside.held)),
    get("/api/prompts", prompts),
    get("/api/accounts", agents.accounts),
    get("/api/accounts/pause", agents.getPause),
    { method: "PUT", pattern: "/api/accounts/pause", operator: true, handler: ok(agents.putPause) },
    get("/api/accounts/jev", agents.getJev),
    { method: "PUT", pattern: "/api/accounts/jev", operator: true, handler: ok(agents.putJev) },
    { method: "PUT", pattern: "/api/accounts/:id", operator: true, handler: ok(agents.putAccount) },
    { method: "POST", pattern: "/api/accounts", operator: true, handler: ok(agents.postAccount) },
    { method: "POST", pattern: "/api/accounts/:id/login", operator: true, handler: ok(agents.loginStart) },
    { method: "POST", pattern: "/api/accounts/:id/login/code", operator: true, handler: ok(agents.loginCode) },
    { method: "POST", pattern: "/api/accounts/:id/login/cancel", operator: true, handler: ok(agents.loginCancel) },
    { method: "POST", pattern: "/api/accounts/:id/token", operator: true, handler: ok(agents.tokenStart) },
    { method: "POST", pattern: "/api/accounts/:id/token/code", operator: true, handler: ok(agents.tokenCode) },
    { method: "POST", pattern: "/api/accounts/:id/token/cancel", operator: true, handler: ok(agents.tokenCancel) },
    { method: "POST", pattern: "/api/accounts/:id/token/remove", operator: true, handler: ok(agents.tokenRemove) },
    { method: "POST", pattern: "/api/accounts/:id/sign-out", operator: true, handler: ok(agents.accountSignOut) },
    { method: "POST", pattern: "/api/accounts/:id/refresh", operator: true, handler: ok(agents.accountRefresh) },
    get("/api/agents", agents.list),
    get("/api/agents/:id", agents.detail),
    get("/api/rates", agents.rates),
    get("/api/envs", build.envs),
    get("/api/envs/caches", build.caches),
    { method: "POST", pattern: "/api/envs", operator: true, handler: ok(build.postEnv) },
    { method: "PUT", pattern: "/api/envs/:id", operator: true, handler: ok(build.putEnv) },
    { method: "POST", pattern: "/api/envs/:id/rotate-key", operator: true, handler: ok(build.postRotate) },
    get("/api/workspaces", workspaces.list),
    get("/api/workspaces/:id", workspaces.detail),
    get("/api/workspaces/:id/calls", workspaces.calls),
    get("/api/workspaces/:id/calls/:call", workspaces.output),
    { method: "GET", pattern: "/api/workspaces/:id/calls/:call/image", handler: workspaces.image },
    get("/api/tasks", build.tasks),
    get("/api/tasks/:id", build.task),
    { method: "POST", pattern: "/api/tasks/:id/cancel", handler: ok(build.cancel) },
    { method: "GET", pattern: "/api/tasks/:id/artifacts/:name", handler: build.artifact },
    { method: "GET", pattern: "/api/implementations/:id/shots/:file", handler: build.implementationShot },
    get("/api/nightly", nightly.grid),
    get("/api/nightly/bench/:repo/:bench", nightly.series),
    { method: "POST", pattern: "/api/nightly/select", handler: ok(nightly.select) },
    get("/api/build/summary", build.buildSummary),
    get("/api/build/features", build.features),
    { method: "POST", pattern: "/api/build/features", handler: ok(build.postFeature) },
    get("/api/build/screenshots", build.screenshots),
    { method: "PUT", pattern: "/api/build/screenshots/:repo", handler: ok(build.putScreenshots) },
    { method: "DELETE", pattern: "/api/build/screenshots/:repo", handler: ok(build.deleteScreenshots) },
    scoped(get("/api/next", next)),
    scoped(heavy(get("/api/queue", queue))),
    scoped(heavy(get("/api/queue/batches", queueBatches))),
    get("/api/batches/:id", batchOne),
    scoped(get("/api/work", work)),
    scoped(get("/api/queue/page", queuePage)),
    get("/api/repos/pipeline", pipelineRepoNames),
    get("/api/fast-track", fastTrackRefs),
    get("/api/merge/held", heldMergeRefs),
    { method: "POST", pattern: "/api/fast-track", handler: ok(fastTrackAdd) },
    { method: "POST", pattern: "/api/fast-track/remove", handler: ok(fastTrackRemove) },
    { method: "POST", pattern: "/api/fast-track/weight", handler: ok(fastTrackWeight) },
    post("/api/queue/add", queueAdd),
    { method: "POST", pattern: "/api/merge/hold", handler: ok(async (db, req) => mergeHoldPr(db, req, true)) },
    { method: "POST", pattern: "/api/merge/release", handler: ok(async (db, req) => mergeHoldPr(db, req, false)) },
    { method: "POST", pattern: "/api/merge/batch-remove", handler: ok(async (db, req) => batchRemovePr(db, req, opts.exec)) },
    { method: "POST", pattern: "/api/queue/batches/:id/stop", handler: ok(async (db, req) => batchStop(db, req, opts.exec)) },
    get("/api/repos/:repo/security", security.security),
    post("/api/repos/:repo/security/scans", security.startScan),
    get("/api/security/scans", security.scans),
    get("/api/security/scans/:id", security.scanOf),
    post("/api/security/scans/:id/stop", security.stopScan),
    post("/api/security/scans/:id/continue", security.continueScan),
    get("/api/security/findings/:repo/:n", security.finding),
    post("/api/security/findings/:repo/:n", security.actOnFinding),
    scoped(get("/api/needs", needs)),
    get("/api/needs/fixes/:repo", needsFixes),
    get("/api/flow", flow),
    scoped(get("/api/now", now)),
    scoped(get("/api/live", live)),
    scoped(get("/api/now/feed", nowFeed)),
    heavy(get("/api/similar/:repo/:n", async (db, req) => sim.similar(db, req, vectors))),
    get("/api/security/findings", securityPage.securityFindings),
    get("/api/security/findings/:repo/:n/page", securityPage.findingPage),
    scoped(get("/api/home", async (db, req) => home(db, req, { progress: async (hidden) => await progress(db, hidden) }))),
    scoped(get("/api/items/status", items.statusList)),
  ];
}
