// The Queue page: tabs All, Review, Fix, Verify and Merge over one repo filter, with fast-tracked items first, plus
// the operator's fast-track, hold and batch controls. Reads are for anyone signed in, limited to the repos the
// requester may see; every write is for operators (the route says so) and audited.
import { prBuildView } from "../../prbuild/view.ts";
import { canSeeInternals } from "./staff.ts";
import type { FastPosition, MergeWait, NextMerge, QueueMergeRow, QueueOrigin, QueuePage, QueuePendingRow, QueueRepos, QueueTab, QueueWorkRow, TypeLabel } from "../../../web/src/api/types.ts";
import { cachedQueue, openViews, type CachedEntry } from "../../core/plan-read.ts";
import { addFastTrack, fastPositions, fastTrackList, FastTrackError, parseItemRef, parseWeight, removeFastTrack, setFastTrackWeight, WEIGHT_DEFAULT } from "../../fasttrack.ts";
import { HEAD_CHANGED, preapproveMerge } from "../../preapproval/index.ts";
import { requireSettle } from "../../settlers.ts";
import type { Exec } from "../../fixup/git.ts";
import { ControlError, holdMerge, releaseMerge, removeFromBatch, stopBatch } from "../../merge/controls.ts";
import { pageBatches } from "../../merge/batch-store.ts";
import { pipelineRepos } from "../../pilot.ts";
import { mergeOrder, queueSlots, scoreLookup } from "../../rank/position.ts";
import { classifyListOf, NOT_PLANNED } from "../../rank/next.ts";
import type { RankBreakdown } from "../../rank/score.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { toBatch, toRow } from "./queue.ts";
import { needVisible, visibleRepos } from "./visible.ts";
import { mayRunRepo } from "../repo-access.ts";
import { readerOf, statusFor, veiledFor, type Reader } from "./reader.ts";
import { stageById } from "../../stages/registry.ts";
import { flatMapSeq } from "../../async-seq.ts";
import type { Db } from "../../db/index.ts";
import { audit } from "../audit.ts";
import { applyAnswer } from "./decisions.ts";
import { getDecision, optionsOf } from "../../decisions.ts";
import { decisionId as scopeDecisionId, SCOPE_OPTIONS } from "../../decide/decision.ts";
import { currentImplementation, latestAttempts, type LatestAttempt } from "../../implement/store.ts";
import { ENDED_STATES, type ImplementationState } from "../../implement/types.ts";
import { takerTest } from "../../remote/takers.ts";
import { promptTier } from "../../remote/bundle.ts";
import { implementRefusal } from "../../implement/gate.ts";
import type { NotNull } from "kysely";
import * as kx from "../../db/kx.ts";

export const TABS: QueueTab[] = ["all", "review", "fix", "verify", "merge"];
const NEXT_LIMIT = 10;

/** The tab a work row belongs to besides All, from its next step. */
export function tabOfNext(next: string): QueueTab | null {
  if (next === stageById("review").title) return "review";
  if (next.startsWith("Fix") || next.startsWith("Implement")) return "fix";
  if (next.startsWith("Verify")) return "verify";
  return null;
}

const WAITS: Record<string, [MergeWait, string, number]> = {
  ready: ["ready", "Ready", 0],
  "decision-answered-merge": ["ready", "Merge approved", 0],
  refused: ["refused", "Refused; tried again when GitHub reports something new", 1],
  "in-batch": ["batch-ci", "In a batch; waiting for the batch PR's CI", 1],
  "batch-checking": ["batch-check", "In a batch; checked in the sandbox", 1],
  "waiting-ci": ["ci", "Waiting for CI", 2],
  "waiting-main-ci": ["ci", "Waiting: main CI red", 2],
  "ci-approval": ["ci", "Waiting for CI run approval", 2],
  "waiting-verify": ["verify", "Waiting for Verify", 2],
  "waiting-premerge": ["premerge", "Waiting for the pre-merge review", 2],
};
const HELD: [MergeWait, string, number] = ["held", "Merge held by an operator", 9];

/** What merges next and what each PR waits for, from the queue states (src/merge/queue.ts). Fast-tracked first, held last. */
export function nextMerges(entries: CachedEntry[], fast: Map<string, FastPosition>, batchOf: Map<string, { id: number; branch: string }>, scores: Map<string, number>): NextMerge[] {
  const items = entries.flatMap((e) => {
    const w = e.held && e.state in WAITS ? HELD : e.state === "ci-approval" && e.runsBlocked ? WAITS[e.state]!.map((x, k) => (k === 1 ? "CI runs need a person to approve" : x)) as [MergeWait, string, number] : WAITS[e.state];
    return w ? [{ e, w }] : [];
  });
  items.sort((a, b) => {
    const fa = fast.get(`${a.e.repo}#${a.e.number}`)?.position ?? Infinity, fb = fast.get(`${b.e.repo}#${b.e.number}`)?.position ?? Infinity;
    return (a.w[2] === 9 ? 1 : 0) - (b.w[2] === 9 ? 1 : 0) || fa - fb || a.w[2] - b.w[2]
      || (scores.get(`${b.e.repo}#${b.e.number}`) ?? -1) - (scores.get(`${a.e.repo}#${a.e.number}`) ?? -1) || a.e.repo.localeCompare(b.e.repo) || a.e.number - b.e.number;
  });
  return items.slice(0, NEXT_LIMIT).map(({ e, w }) => ({
    repo: e.repo, number: e.number, title: e.title, waitsFor: w[0], label: w[1], fast: fast.get(`${e.repo}#${e.number}`) ?? null, batch: batchOf.get(`${e.repo}#${e.number}`) ?? null,
  }));
}

export async function queuePage(db: Db, req: Req): Promise<QueuePage> {
  const tab = (req.query.get("tab") || "all") as QueueTab;
  if (!TABS.includes(tab)) throw new HttpError(400, `tab must be one of ${TABS.join(", ")}`);
  const reposParam = (req.query.get("repos") || "pipeline") as QueueRepos;
  const limit = Math.min(Math.max(Number(req.query.get("limit")) || 100, 1), 500);
  const offset = Math.max(Number(req.query.get("offset")) || 0, 0);
  const visible = await visibleRepos(db, req);
  const visibleSet = new Set(visible);
  if (reposParam !== "pipeline" && reposParam !== "all" && !visibleSet.has(reposParam)) throw new HttpError(404, `${reposParam} is not a tracked repo`);
  const internals = canSeeInternals(req);
  // The page's reads do not depend on each other, so they run together.
  const [views, fastAll, holds, allEntries, slots, ranked, reader, closes, originOf] = await Promise.all([
    reposParam === "pipeline" ? openViews(db) : null, fastPositions(db),
    db.all(db.k.selectFrom("main.merge_holds").select(["repo", "number"])),
    // Work rows (All, Review, Fix, Verify): each item's next step is the one its cached Plan stored; the position badges read the same rows.
    cachedQueue(db, { merged: "exclude" }), queueSlots(db, visible),
    db.all(db.k.selectFrom("items as i").innerJoin("item_rank as r", (j) => j.onRef("r.repo", "=", "i.repo").onRef("r.number", "=", "i.number"))
      .leftJoin("item_plans as p", (j) => j.onRef("p.repo", "=", "i.repo").onRef("p.number", "=", "i.number"))
      .select(["i.repo", "i.number", "i.kind", "i.title", "r.score", "r.breakdown", kx.jsonText(db, "p.view", "$.next").as("next"), kx.jsonText(db, "p.view", "$.label").as("label"), "p.item_state"])
      .where("i.state", "=", "OPEN").orderBy("r.score", "desc").orderBy("i.repo").orderBy("i.number")),
    readerOf(db, req), closingIssues(db), queueOrigins(db, internals),
  ]);
  const scoped = views ? new Set([...views].filter(([, v]) => v.scope).map(([k]) => k)) : null;
  const fast = new Map([...fastAll].filter(([k]) => visibleSet.has(k.slice(0, k.lastIndexOf("#")))));
  // The default view is the pipeline's scope (src/rank/position.ts), the same one the position badges count.
  const inScope = (repo: string, number: number): boolean =>
    reposParam === "all" ? visibleSet.has(repo) : reposParam === "pipeline" ? visibleSet.has(repo) && scoped!.has(`${repo}#${number}`) : repo === reposParam;
  const fastOf = (repo: string, number: number): FastPosition | null => fast.get(`${repo}#${number}`) ?? null;
  const held = new Set(holds.map((r) => `${r.repo}#${r.number}`));

  // A linked item (`item=repo:number`) comes with the first page: it is cut long enough to include the item.
  const item = req.query.get("item");
  const indexOf = (list: { repo: string; number: number }[]): number | null => {
    const at = item ? list.findIndex((r) => `${r.repo}:${r.number}` === item) : -1;
    return at < 0 ? null : at;
  };
  const sizeFor = (list: { repo: string; number: number }[], from: number): number => {
    const at = from === 0 ? indexOf(list) : null;
    return at === null ? limit : Math.min(500, Math.max(limit, Math.ceil((at + 1) / 100) * 100));
  };

  const score = scoreLookup(db);
  // Fast-tracked items (and the Fix PRs of fast-tracked issues) first, then the work rank.
  const inView = await Promise.all(ranked.filter((r) => visibleSet.has(r.repo) && inScope(r.repo, r.number)).map(async (r) => ({ r, s: await score(r.repo, r.number) ?? r.score })));
  inView.sort((a, b) => b.s - a.s);
  const work: QueueWorkRow[] = inView.map(({ r }) => {
    const bd = JSON.parse(r.breakdown) as RankBreakdown;
    return {
      repo: r.repo, number: r.number, kind: r.kind === "pr" ? "pr" : "issue", title: r.title ?? "", score: r.score, level: bd.level, size: bd.size, breakdown: bd,
      label: r.label as TypeLabel | null, next: r.next ?? NOT_PLANNED, nextHref: r.item_state === "referee-due" ? classifyListOf(r.repo) : null,
      queue: slots.get(`${r.repo}#${r.number}`) ?? null, fast: fastOf(r.repo, r.number), held: held.has(`${r.repo}#${r.number}`),
    };
  });

  // Merge queue rows
  const entries = allEntries.filter((e) => e.state !== "merged" && visibleSet.has(e.repo) && inScope(e.repo, e.number));
  const asRow = async (e: CachedEntry): Promise<QueueMergeRow> => ({ ...toRow(e, reader), fast: fastOf(e.repo, e.number), held: e.held, prBuild: await prBuildView(db, e.repo, e.number, e.head, internals), closes: closes.get(`${e.repo}#${e.number}`) ?? [], added: await originOf(e) });
  // Tabs come from the stored next step; the text is veiled afterwards, so a quiet pull request stays in its tab.
  const tabOf = new Map(work.map((w) => [w, tabOfNext(w.next)]));
  const veilNext = (w: QueueWorkRow): QueueWorkRow => (veiledFor(reader, w.repo, w.number) ? { ...w, next: "" } : w);
  const pending = await pendingRows(db, entries, allEntries, inScope, originOf, fastOf, held, reader, internals);
  const count = (t: QueueTab): number => (t === "all" ? work.length : t === "merge" ? entries.length + pending.length : work.filter((w) => tabOf.get(w) === t).length);
  const counts = { all: count("all"), review: count("review"), fix: count("fix"), verify: count("verify"), merge: count("merge") };

  const out: QueuePage = { tab, repos: reposParam, counts, rows: [], mergeRows: [], nextMerges: [], batches: [], total: 0, next: null };
  if (tab !== "merge") {
    const match = tab === "all" ? work : work.filter((w) => tabOf.get(w) === tab);
    out.itemIndex = indexOf(match);
    out.rows = match.slice(offset, offset + sizeFor(match, offset)).map(veilNext);
    out.total = match.length;
    out.next = offset + out.rows.length < match.length ? offset + out.rows.length : null;
    return out;
  }
  const [{ batches }, rows, rankRows, ordered] = await Promise.all([
    pageBatches(db, { hidden: reader.hidden, limit: 100 }),
    Promise.all(entries.map(async (e) => [e, await asRow(e)] as const)),
    db.all(db.k.selectFrom("item_rank").select(["repo", "number", "score"])),
    mergeOrder(db, entries),
  ]);
  const active = batches.filter((b) => (b.state === "checking" || b.state === "open") && b.prs.some((p) => inScope(b.repo, p.number)));
  const rowOfEntry = new Map(rows);
  const rowOf = new Map(rows.map(([e, r]) => [`${e.repo}#${e.number}`, r]));
  const batchOf = new Map(active.flatMap((b) => b.prs.map((p) => [`${b.repo}#${p.number}`, { id: b.id, branch: b.branch }] as const)));
  const scores = new Map(rankRows.map((r) => [`${r.repo}#${r.number}`, r.score]));
  // The merge rows are the ones built above, in merge order.
  const free = ordered.map((e) => rowOfEntry.get(e)!);
  out.itemIndex = indexOf(free);
  out.mergeRows = free.slice(offset, offset + sizeFor(free, offset));
  out.total = free.length;
  out.next = offset + out.mergeRows.length < free.length ? offset + out.mergeRows.length : null;
  out.nextMerges = nextMerges(entries, fast, batchOf, scores);
  out.batches = active.map((b) => toBatch(b, reader, b.prs.flatMap((p) => rowOf.get(`${b.repo}#${p.number}`) ?? [])));
  out.pending = pending;
  return out;
}

/**
 * Open PRs queued with Queue items or pre-approved that are no merge queue row yet: no take review at their head, so they wait for
 * the fix-up or the review first. `entries` are the queue rows the view shows and `want` is the view's scope, so a PR is in exactly one
 * group. Oldest first. Then the open fast-tracked issues none of whose closing PRs is listed: Fix builds their PR, which then comes
 * through review into the queue; an issue leaves the group once a PR that closes it is listed, in any scope (`all` are every queue row). In fast-track order.
 */
async function pendingRows(db: Db, entries: CachedEntry[], all: CachedEntry[], want: (repo: string, number: number) => boolean, originOf: (e: Pick<CachedEntry, "repo" | "number" | "decisionId" | "reviewedAt">) => Promise<QueueOrigin>,
  fastOf: (repo: string, number: number) => FastPosition | null, held: Set<string>, reader: Reader, staff: boolean): Promise<QueuePendingRow[]> {
  const queued = new Set(entries.map((e) => `${e.repo}#${e.number}`));
  const [rows, fast] = await Promise.all([db.all(db.k.selectFrom("preapprovals as p").innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "p.repo").onRef("i.number", "=", "p.number"))
    .leftJoin("item_rank as r", (j) => j.onRef("r.repo", "=", "p.repo").onRef("r.number", "=", "p.number"))
    .select(["p.repo", "p.number", "p.state", "i.title", "i.author", "r.breakdown"]).$narrowType<{ state: "fixup" | "review" | "ci" }>()
    .where("p.state", "in", ["fixup", "review", "ci"]).where("i.state", "=", "OPEN").where("i.kind", "=", "pr").orderBy("p.id")),
    db.all(db.k.selectFrom("main.fast_track as f").innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "f.repo").onRef("i.number", "=", "f.number"))
    .leftJoin("item_rank as r", (j) => j.onRef("r.repo", "=", "f.repo").onRef("r.number", "=", "f.number"))
    .leftJoin("item_plans as pl", (j) => j.onRef("pl.repo", "=", "f.repo").onRef("pl.number", "=", "f.number"))
    .select(["f.repo", "f.number", "i.title", "i.author", "r.breakdown", "f.added_by", "f.added_at", kx.jsonText(db, "pl.view", "$.next").as("next"), "pl.wait"])
    .where("i.state", "=", "OPEN").where("i.kind", "=", "issue").orderBy("f.weight", "desc").orderBy("f.id"))]);
  const seen = new Set<string>();
  const sizeOf = (breakdown: string | null) => (breakdown ? ((JSON.parse(breakdown) as RankBreakdown).size ?? null) : null);
  const shownPrs = rows.filter((p) => {
    const k = `${p.repo}#${p.number}`;
    if (seen.has(k) || queued.has(k) || !want(p.repo, p.number)) return false;
    seen.add(k);
    return true;
  });
  const prs = await Promise.all(shownPrs.map(async (p): Promise<QueuePendingRow> => ({
    repo: p.repo, number: p.number, kind: "pr", title: p.title ?? "", author: p.author ?? "", size: sizeOf(p.breakdown), step: p.state,
    fast: fastOf(p.repo, p.number), held: held.has(`${p.repo}#${p.number}`), added: await originOf({ repo: p.repo, number: p.number, decisionId: null, reviewedAt: "" }),
  })));
  // Listed in any scope: a closing PR queued outside the view's scope still stands for the issue.
  const shownAll = new Set(all.filter((e) => e.held || !UNSHOWN_STATES.has(e.state)).map((e) => `${e.repo}#${e.number}`));
  const queuedAll = new Set(all.map((e) => `${e.repo}#${e.number}`));
  const pendingAll = new Set(rows.map((p) => `${p.repo}#${p.number}`).filter((k) => !queuedAll.has(k)));
  const listed = (repo: string, n: number) => shownAll.has(`${repo}#${n}`) || pendingAll.has(`${repo}#${n}`);
  const [closingOf, attempts] = fast.length ? await Promise.all([openClosingIndex(db), latestAttempts(db)]) : [new Map<string, number[]>(), new Map<string, LatestAttempt>()];
  const takes = takerTest(db, Date.now());
  const issues = await flatMapSeq(fast, async (f): Promise<QueuePendingRow[]> => {
    if (!want(f.repo, f.number)) return [];
    const closing = closingOf.get(`${f.repo}#${f.number}`) ?? [];
    if (closing.some((n) => listed(f.repo, n))) return [];
    const im = attempts.get(`${f.repo}#${f.number}`);
    const live = im && !ENDED_STATES.has(im.state) ? im : undefined;
    const step = closing.length ? "pr" : live ? "implement" : f.next !== null && FIX_BUILDS.has(f.next) ? "build" : "next";
    return [{
      repo: f.repo, number: f.number, kind: "issue", title: f.title ?? "", author: f.author ?? "", size: sizeOf(f.breakdown), step,
      fast: fastOf(f.repo, f.number), held: false, added: { how: "fast", by: staff ? f.added_by || null : null, at: f.added_at },
      prs: closing, next: statusFor(reader, f.repo, f.number, { waiting: null, next: f.next ?? NOT_PLANNED }).next,
      ...(live && { implement: { state: live.state, text: implementText(live), wait: await implementWait(live, f.wait, takes, staff) } }),
    }];
  });
  return [...prs, ...issues];
}

/**
 * How each PR came into the merge queue, and who put it there: an active pre-approval (added with Queue items, a Merge answer carried to a
 * new head, or a pre-approval after a fix-up), else an operator's Merge answer at the reviewed head, else the take review itself.
 * Operator logins are shown to staff only.
 */
export async function queueOrigins(db: Db, staff: boolean): Promise<(e: Pick<CachedEntry, "repo" | "number" | "decisionId" | "reviewedAt">) => Promise<QueueOrigin>> {
  type Pre = { id: number; repo: string; number: number; by: string; at: string; instructions: string; from_head: string; head: string | null };
  const pre = new Map<string, Pre>();
  for (const p of await db.all(db.k.selectFrom("preapprovals").select(["id", "repo", "number", "by", "at", "instructions", "from_head", "head"]).where("state", "in", ["fixup", "review", "ci", "queued"]).orderBy("id"))) pre.set(`${p.repo}#${p.number}`, p);
  const answer = async (id: string) => await db.get(db.k.selectFrom("decisions").select(["answered_by", "answered_at"]).where("id", "=", id).where("answer", "=", "merge"));
  // A Merge answer carried to a new head is audited as such when its row is made; a queued row's head also moves with our own pushes.
  const carried = async (target: string, id: number) => await db.get(db.k.selectFrom("audit").select((eb) => eb.lit(1).as("one")).where("action", "=", "preapproval").where("target", "=", target)
    .where(kx.jsonNum(db, "details", "$.id"), "=", id).where(kx.jsonText(db, "details", "$.carried"), "is not", null).limit(1));
  const who = (login: string | null | undefined) => (staff ? login || null : null);
  return async (e) => {
    const p = pre.get(`${e.repo}#${e.number}`);
    if (p) return { how: p.instructions ? "preapproved" : await carried(`${p.repo}#${p.number}`, p.id) ? "answer" : "queued", by: who(p.by), at: p.at };
    const d = e.decisionId ? await answer(e.decisionId) : undefined;
    if (d) return { how: "answer", by: who(d.answered_by), at: d.answered_at };
    return { how: "review", by: null, at: e.reviewedAt };
  };
}

/** The issues each PR closes when it merges (GitHub's closing references, from the mirror), by `repo#number`; PRs without any are left out. */
async function closingIssues(db: Db): Promise<Map<string, number[]>> {
  const rows = await db.all(db.k.selectFrom(kx.indexedBy(db, "main.items", "items_closing", "i")).select(["i.repo", "i.number", "i.closing_issues"]).$narrowType<{ closing_issues: NotNull }>()
    .where("i.kind", "=", kx.literal("pr")).where("i.closing_issues", "is not", null).where("i.closing_issues", "<>", kx.literal("[]")));
  const out = new Map<string, number[]>();
  for (const r of rows) {
    try {
      const ns = (JSON.parse(r.closing_issues) as unknown[]).filter((x): x is number => typeof x === "number");
      if (ns.length) out.set(`${r.repo}#${r.number}`, ns);
    } catch {
      // A malformed list is left out.
    }
  }
  return out;
}

// ---- repo list, fast track and merge controls --------------------------------

/** Visible repos whose pipeline is on. */
export async function pipelineRepoNames(db: Db, req: Req): Promise<string[]> {
  const on = await pipelineRepos(db);
  return (await visibleRepos(db, req)).filter((r) => on.has(r));
}

/** Open fast-tracked items as `repo#number`, first to run first. */
export async function fastTrackRefs(db: Db, req: Req): Promise<string[]> {
  const visible = new Set(await visibleRepos(db, req));
  return (await fastTrackList(db)).filter((f) => visible.has(f.repo)).map((f) => `${f.repo}#${f.number}`);
}

/** PRs whose merge an operator holds, as `repo#number`, in visible repos. */
export async function heldMergeRefs(db: Db, req: Req): Promise<string[]> {
  const visible = new Set(await visibleRepos(db, req));
  const rows = await db.all(db.k.selectFrom("main.merge_holds").select(["repo", "number"]).orderBy("repo").orderBy("number"));
  return rows.filter((r) => visible.has(r.repo)).map((r) => `${r.repo}#${r.number}`);
}

function item(req: Req): { repo: string; number: number } {
  const b = req.json;
  const text = b && typeof b === "object" && !Array.isArray(b) ? (b as { item?: unknown }).item : undefined;
  try {
    return parseItemRef(text);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

/** Runs a library call, turning its errors into HTTP ones. */
/** Fast track, hold and the batch controls are for whoever runs the repo (src/dash/repo-access.ts). */
async function needRunner(req: Req, repo: string): Promise<void> {
  if (!(await mayRunRepo(req.user, repo))) throw new HttpError(403, "no write access to this repo");
}

async function guarded<T>(f: () => Promise<Promise<T> | T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof FastTrackError || e instanceof ControlError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

export async function fastTrackAdd(db: Db, req: Req): Promise<string[]> {
  const r = item(req);
  await needVisible(db, req, r.repo);
  await needRunner(req, r.repo);
  await guarded(async () => await addFastTrack(db, req.user.login, `${r.repo}#${r.number}`));
  return fastTrackRefs(db, req);
}

/** The `weight` of the JSON body as sent, unchecked. */
function rawWeight(req: Req): unknown {
  const b = req.json;
  return b && typeof b === "object" && !Array.isArray(b) ? (b as { weight?: unknown }).weight : undefined;
}

/** The `weight` of the JSON body, checked; the default when it has none. */
function weightOf(req: Req): number {
  const w = rawWeight(req);
  try {
    return parseWeight(w);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

export async function fastTrackWeight(db: Db, req: Req): Promise<string[]> {
  const r = item(req);
  const w = weightOf(req);
  await needVisible(db, req, r.repo);
  await needRunner(req, r.repo);
  await guarded(async () => await setFastTrackWeight(db, req.user.login, `${r.repo}#${r.number}`, w));
  return fastTrackRefs(db, req);
}

/**
 * Fast-tracks an item with weight `w`; one already fast-tracked keeps a heavier weight it has, so this only ever moves it up. `w` null is a
 * maintainer's line: an item not on the list gets the default weight and an existing weight stays, since weights are set by operators.
 */
async function markFast(db: Db, by: string, repo: string, number: number, w: number | null, via?: string): Promise<void> {
  const ref = `${repo}#${number}`;
  const had = (await db.get(db.k.selectFrom("main.fast_track").select("weight").where("repo", "=", repo).where("number", "=", number)))?.weight;
  await guarded(async () => (had === undefined ? await addFastTrack(db, by, ref, w ?? WEIGHT_DEFAULT, via) : w !== null && w > had ? await setFastTrackWeight(db, by, ref, w, via) : null));
}

/**
 * Queues an issue: markFast, and on an issue already on the list a new queue time (the planner starts a new implementation
 * when an ended one was queued again after it ended: issue-facts.ts requeuedAfterEnd). With no implementation under way the
 * person queueing it becomes its queuer, whose Task Runner runs its model calls.
 */
export async function queueIssue(db: Db, by: string, repo: string, number: number, w: number | null, via?: string): Promise<void> {
  const had = await db.get(db.k.selectFrom("main.fast_track").select("added_by").where("repo", "=", repo).where("number", "=", number));
  await markFast(db, by, repo, number, w, via);
  if (!had) return;
  await guarded(async () => {
    const current = await currentImplementation(db, repo, number);
    await db.run(db.k.updateTable("main.fast_track").set({ added_at: new Date().toISOString(), ...(current ? {} : { added_by: by }) }).where("repo", "=", repo).where("number", "=", number));
    await audit(db, by, "fasttrack-requeue", `${repo}#${number}`, { ...(current ? {} : { from: had.added_by }), ...(via ? { via } : {}) });
  });
}

/** A queued issue counts as wanted: an open scope decision on it is answered `take` by the person queueing it. Returns a clause for the label. */
async function takeScope(db: Db, by: string, repo: string, number: number, via?: string): Promise<string> {
  const d = await getDecision(db, scopeDecisionId({ repo, number }));
  if (!d || d.answer || !optionsOf(d).some((o) => o.key === SCOPE_OPTIONS.take.key)) return "";
  try {
    await applyAnswer(db, d, by, { answer: SCOPE_OPTIONS.take.key, note: "Queued for implementation." }, "queue", via);
    return `; its scope question is answered ${SCOPE_OPTIONS.take.label}`;
  } catch (e) {
    return `; its scope question stays open: ${(e as Error).message}`;
  }
}

/** The open PRs of `repo` that close issue `issue` when they merge (GitHub's closing references, from the mirror), in number order. */
export async function openPrsClosing(db: Db, repo: string, issue: number): Promise<number[]> {
  return (await openClosingIndex(db, repo)).get(`${repo}#${issue}`) ?? [];
}

/** The open PRs that close each issue, by `repo#issue`, in number order; of one repo, or of every repo when `repo` is left out. */
async function openClosingIndex(db: Db, repo?: string): Promise<Map<string, number[]>> {
  const rows = await db.all(db.k.selectFrom(kx.indexedBy(db, "main.items", "items_closing", "i")).select(["i.repo", "i.number", "i.closing_issues"]).$narrowType<{ closing_issues: NotNull }>()
    .$if(repo !== undefined, (q) => q.where("i.repo", "=", repo!))
    .where("i.kind", "=", kx.literal("pr")).where("i.state", "=", "OPEN").where("i.closing_issues", "is not", null).where("i.closing_issues", "<>", kx.literal("[]")));
  const out = new Map<string, number[]>();
  for (const p of rows) {
    let issues: unknown[];
    try {
      issues = JSON.parse(p.closing_issues) as unknown[];
    } catch {
      continue;
    }
    for (const n of new Set(issues)) if (typeof n === "number") out.set(`${p.repo}#${n}`, [...(out.get(`${p.repo}#${n}`) ?? []), p.number]);
  }
  for (const l of out.values()) l.sort((a, b) => a - b);
  return out;
}

/** What an implementation in each state does, for the Queue's step column. */
const IMPLEMENT_STEP: Record<ImplementationState, string> = {
  planning: "Planning", asked: "Question asked", planned: "Planned", implementing: "Writing the change", checking: "AutoCraft's checks", fixing: "Follow-up on findings",
  opening: "Opening the PR", "pr-opened": "PR opened", revising: "Revising the PR", stuck: "Stuck", merged: "Merged", closed: "Closed", failed: "Failed", cancelled: "Cancelled",
};
const implementText = (im: { state: ImplementationState; attempt: number }): string => `${IMPLEMENT_STEP[im.state]}${im.attempt > 1 ? `, attempt ${im.attempt}` : ""}`;

/**
 * What an implementation waits for: a person's answer or decision, the planner's wait, or the queuer's Task Runner, which
 * takes every model call of the implementation (viewers do not see whose it is).
 */
async function implementWait(im: { state: ImplementationState; queuedBy: string; repo: string; question: { audience: string | null } | null }, wait: string | null,
  takes: ReturnType<typeof takerTest>, staff: boolean): Promise<string | null> {
  if (im.state === "asked") return im.question?.audience === "maintainer" ? "Waits for a maintainer's answer" : "Waits for the author's answer";
  if (im.state === "stuck") return "Waits for a decision";
  if (im.state === "pr-opened") return null;
  const prompt = im.state === "planning" ? "implement.plan" : "implement.session";
  if (!await takes({ prompt_id: prompt, repos: [im.repo], forLogin: im.queuedBy, tier: promptTier(prompt) })) {
    return `Runs only on ${staff ? `${im.queuedBy}'s` : "the queuer's"} Task Runner, which is not ready`;
  }
  return wait ? `Waits for ${wait}` : null;
}

/** The planner's next steps of an issue whose PR Fix is building (src/core/decide-item.ts nextStep). */
const FIX_BUILDS = new Set(["Implement", "Implement: planning", "Implement: in progress"]);

/** Queue states the Merge board puts in no group unless the PR has a merge hold (web/src/modules/queue/MergeBoard.tsx: neither a step nor stopped). */
const UNSHOWN_STATES = new Set<string>(["declined", "held-duplicate", "held-backlog", "merged"]);

/** What Queue items does, as the refusal of `settleRefusal` names it. */
export const queueWhat = (repo: string): string => `queues items on ${repo}`;

/**
 * "Queue items", one line, for an operator or a maintainer who settles on the repo. A PR is pre-approved at its current head (it merges once the review says take, the pre-merge review is clean
 * and CI is green) and fast-tracked with the weight, so its review, checks and merge come first. An issue is fast-tracked, so Fix works it
 * first; when exactly one open PR closes it, that PR is queued as above. Several closing PRs are only listed: a person picks one.
 * Weights stay with operators: a maintainer's line fast-tracks with the default weight and ignores a weight it names.
 * `pin` (a command in a comment) names the one head each PR may be pre-approved at, or null for a PR that may not be queued: one
 * opened or pushed to after the comment.
 */
export async function queueAdd(db: Db, req: Req, via?: string, pin?: (pr: number) => string | null): Promise<{ label: string; fast: string[] }> {
  const r = item(req);
  const operator = req.user.role === "operator";
  const w = operator ? weightOf(req) : null;
  const raw = rawWeight(req);
  const ignored = !operator && raw !== undefined && raw !== null && raw !== "" ? ". The weight was ignored: only operators set fast-track weights" : "";
  await needVisible(db, req, r.repo);
  // A pre-approved merge is a Merge answer given ahead, so it takes the rule of an answer (src/settlers.ts): an operator with write access, or a maintainer where they settle decisions.
  await requireSettle(db, req.user, [r.repo], queueWhat(r.repo));
  const by = req.user.login;
  const kind = (await db.get(db.k.selectFrom("main.items").select("kind").where("repo", "=", r.repo).where("number", "=", r.number)))?.kind;
  if (kind === "issue") {
    await queueIssue(db, by, r.repo, r.number, w, via);
    const prs = await openPrsClosing(db, r.repo, r.number);
    const scope = await takeScope(db, by, r.repo, r.number, via);
    if (!prs.length) {
      const waits = await implementRefusal(db, r.repo, r.number);
      return { label: `${waits ? `Queued; it is not implemented while ${waits}` : "Queued: AutoCraft plans and implements it"}${scope}${ignored}`, fast: await fastTrackRefs(db, req) };
    }
    let rest: string;
    if (prs.length > 1) rest = `${prs.map((n) => `#${n}`).join(", ")} close it; queue one of them`;
    else if (pin && pin(prs[0]!) === null) rest = `#${prs[0]} closes it but was opened or pushed to after your comment, so it was not queued; comment on #${prs[0]} to queue it`;
    else {
      try {
        await preapproveMerge(db, { repo: r.repo, number: prs[0]!, by, via, ...(pin ? { head: pin(prs[0]!)! } : {}) });
        try {
          await markFast(db, by, r.repo, prs[0]!, w, via);
          rest = `queued #${prs[0]}, which closes it`;
        } catch (e) {
          rest = `queued #${prs[0]}, which closes it, but did not fast-track it: ${(e as Error).message}`;
        }
      } catch (e) {
        rest = `#${prs[0]} closes it but was not queued: ${(e as Error).message}`;
      }
    }
    return { label: `Fast-tracked the issue; ${rest}${scope}${ignored}`, fast: await fastTrackRefs(db, req) };
  }
  let done: { label: string };
  const head = pin ? pin(r.number) : undefined;
  if (head === null) throw new HttpError(409, HEAD_CHANGED);
  try {
    done = await preapproveMerge(db, { repo: r.repo, number: r.number, by, via, ...(head === undefined ? {} : { head }) });
  } catch (e) {
    throw new HttpError(409, (e as Error).message);
  }
  await markFast(db, by, r.repo, r.number, w, via);
  return { label: `${done.label}${ignored}`, fast: await fastTrackRefs(db, req) };
}

export async function fastTrackRemove(db: Db, req: Req): Promise<string[]> {
  const r = item(req);
  await needVisible(db, req, r.repo);
  await needRunner(req, r.repo);
  await guarded(async () => await removeFastTrack(db, req.user.login, `${r.repo}#${r.number}`));
  return fastTrackRefs(db, req);
}

export async function mergeHoldPr(db: Db, req: Req, on: boolean): Promise<{ ok: true }> {
  const r = item(req);
  await needVisible(db, req, r.repo);
  await needRunner(req, r.repo);
  const changed = await guarded(async () => (on ? await holdMerge(db, req.user.login, r.repo, r.number) : await releaseMerge(db, req.user.login, r.repo, r.number)));
  if (!changed) throw new HttpError(409, `${r.repo}#${r.number} is ${on ? "already" : "not"} held`);
  return { ok: true };
}

export async function batchRemovePr(db: Db, req: Req, run?: Exec): Promise<{ batch: string; closed: number | null }> {
  const r = item(req);
  await needVisible(db, req, r.repo);
  await needRunner(req, r.repo);
  return guarded(async () => removeFromBatch(db, req.user.login, r.repo, r.number, run));
}

export async function batchStop(db: Db, req: Req, run?: Exec): Promise<{ batch: string; prs: number[]; held: number[]; closed: number | null }> {
  const id = Number(req.params.id);
  const repo = Number.isInteger(id) ? (await db.get(db.k.selectFrom("main.merge_batches").select("repo").where("id", "=", id)))?.repo : undefined;
  if (!repo) throw new HttpError(404, `no batch ${req.params.id}`);
  await needVisible(db, req, repo);
  await needRunner(req, repo);
  return guarded(async () => stopBatch(db, req.user.login, id, run));
}
