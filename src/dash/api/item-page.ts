// The item page: one GET with everything the two-sided page draws (status, header, Opus reviews, result cards, AutoCraft's history and
// the GitHub side). Built from the item API (`itemCore`), the item trace and the write records. Redaction follows the helpers it reuses:
// viewers get no review text, card details or job errors; a quiet pull request is veiled by the trace context; costs stay visible.
import { isHiddenRepo } from "../../hidden-sql.ts";
import { createHash } from "node:crypto";
import type { CiState, TimelineEntry, DiscordInfo, ItemBar, ItemImplementation, ItemKind, ItemPrBuild, ItemRef, ItemReleases, ItemState, Preapproval, QueueSlot, RepoName, ScreenshotRun, Tier } from "../../../web/src/api/types.ts";
import { statusFromItem, type ItemStatus } from "../../core/item-status.ts";
import { triggerWhy } from "../../review/trigger.ts";
import { GITHUB_ACTIONS } from "../../github/actions.ts";
import { context, contextScope, eventsFrom, shape, traceScope, visibleItem, writeActions, obj, arr, type Ctx, type Ev } from "./trace.ts";
import { timelineOf } from "./item-timeline.ts";
import { implementationFrom, implementationView } from "./item-implementation.ts";
import { barOf } from "./item-bar.ts";
import { discordOf } from "./discord.ts";
import { matchWrites, pushedIn, MATCH_WINDOW_MS, type WriteRow } from "./github-writes.ts";
import { actionsOf as releasesOf } from "../../operator-actions.ts";
import { computeStages, slotsOf } from "../../rank/position.ts";
import { visibleRepos } from "./visible.ts";
import { itemReader, statusFor } from "./reader.ts";
import type { Req } from "../types.ts";
import { contributors } from "../../whitelist.ts";
import { mayRunRepo } from "../repo-access.ts";
import { featureOn } from "../../build/features.ts";
import { loadItemPage, loadItemStamp, type ItemPageFacts } from "../../data/views/item-page.ts";
import { loadItems } from "../../data/mirror/index.ts";
import { itemState } from "./shown.ts";
import type { Db } from "../../db/index.ts";
import type { Preapproval as Leg } from "../../data/workflow/types.ts";
import { isOwnLogin } from "../../github/identity.ts";

export type ItemPhase = ItemStatus["phase"];
export type { ItemStatus };

export type ReviewTrigger = "new-head" | "discussion" | "operator" | "base" | "model-change";
export type ReviewVerdict = "take" | "take-fix" | "hold" | "close";
export interface OpusReviewEntry {
  id: string; head: string; current: boolean; at: string; trigger: ReviewTrigger; why: string; verdict: ReviewVerdict; sure: boolean;
  summary: string; fixes: string[]; risks: string[]; claims: { path: string; line: number; text: string }[]; blockedBy: ItemRef[]; costUsd: number;
}
export interface ReviewHistory { latest: OpusReviewEntry | null; earlier: OpusReviewEntry[] }
export interface GithubEvent {
  id: string; type: "opened" | "comment" | "review" | "label" | "push" | "merged" | "closed"; at: string; actor: string; body: string | null;
  autocraft: { as: string; historyId: string } | null;
}
export interface GithubSide {
  description: string; events: GithubEvent[]; checks: { name: string; state: CiState }[];
  commits: { sha: string; message: string; author: string; at: string; byAutoCraft: boolean }[];
  files: { path: string; additions: number; deletions: number }[]; url: string;
  /** When AutoCraft last read the item from GitHub (poll or webhook re-read); null before the first read since this was recorded. */
  syncedAt: string | null;
}
export interface ItemPageHeader {
  labels: string[]; assignees: string[]; autocraftAssigned: boolean; pipelineOn: boolean; discord: DiscordInfo | null; queue: QueueSlot | null;
  held: boolean; preapproval: Preapproval | null; releases: ItemReleases; tier: Tier; size: "S" | "M" | "L" | "XL" | null;
  /** `held`: a Backlog answer holds the item; `canSettle`: the viewer may put it on the Backlog. */
  backlog: { held: boolean; canSettle: boolean };
}
export interface ItemPageData {
  repo: RepoName; number: number; kind: ItemKind; state: ItemState; title: string; author: string; stamp: string; header: ItemPageHeader;
  status: ItemStatus; bar: ItemBar; costUsd: number; reviews: ReviewHistory; timeline: TimelineEntry[]; github: GithubSide;
  /** PRs: our own build of the newest head; null when the pr-builds switch is off or there is none. */
  prBuild: ItemPrBuild | null;
  /** The screenshot run of the PR's latest head, for staff; empty when there is none. */
  screenshots: ScreenshotRun[];
  /** Issues: the current or newest ended implementation attempt. */
  implementation: ItemImplementation | null;
}
export type ItemPageUnchanged = { unchanged: true; stamp: string };

type Json = Record<string, any>;

const short = (s: string | null | undefined): string => (s ?? "").slice(0, 7);

/** Comment text from GitHub, cleaned for display: no HTML comments or tags, cut at `max` characters. */
const clean = (s: string, max = 1500): string => {
  const t = s.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
};

// ---- the item as the page reads it ------------------------------------------------------------------------------------------------

const CI: Record<string, CiState> = { SUCCESS: "passing", FAILURE: "failing", ERROR: "failing", PENDING: "pending", EXPECTED: "pending" };
const TIER: Record<string, Tier> = { whitelisted: "whitelisted", not: "not", allow: "override-allow", deny: "override-deny" };

type Item = {
  kind: ItemKind; state: ItemState; title: string; body: string; author: string; additions: number; deletions: number; labels: string[];
  createdAt: string; updatedAt: string; closedAt: string | null; mergedAt: string | null; mergedBy: string | null; pipelineOn: boolean;
  ciChecks: { name: string; state: CiState }[]; files: { path: string; additions: number; deletions: number }[]; tier: Tier;
  discord: DiscordInfo; releases: ItemReleases; queue: QueueSlot | null; preapproval: Preapproval | null;
};

/** The pre-approval of the page's shape from a merge leg row. */
const legView = (l: Leg): Preapproval => ({ id: l.id, by: l.by, at: l.at, instructions: l.instructions, state: l.state, fromHead: l.from_head, head: l.head, reason: l.reason, updatedAt: l.updated_at });

const labelsOf = (s: string | null): string[] => arr<unknown>(s).filter((x): x is string => typeof x === "string");

/** The head's check contexts as the checks sync stored them; empty when they belong to an older head. */
function ciChecksOf(f: ItemPageFacts): Item["ciChecks"] {
  const r = f.trace.detail.checks, head = f.trace.detail.item?.head_oid ?? null;
  if (!r || (head !== null && head !== r.head_oid)) return [];
  return arr<{ name?: unknown; state?: unknown } | null>(r.checks).flatMap((c) => (c && typeof c.name === "string" ? [{ name: c.name, state: CI[typeof c.state === "string" ? c.state.toUpperCase() : ""] ?? "none" }] : []));
}

function itemOf(c: Ctx, f: ItemPageFacts, extra: { tier: Tier; discord: DiscordInfo; releases: ItemReleases; slot: QueueSlot | null }, staff: boolean): Item {
  const it = f.trace.detail.item!;
  const pr = it.kind === "pr";
  const leg = pr ? f.legs[f.legs.length - 1] : undefined;
  const pre = leg ? legView(leg) : null;
  return {
    kind: pr ? "pr" : "issue", state: itemState(it.state), title: it.title ?? "", body: it.body ?? "", author: it.author ?? "", additions: it.additions ?? 0, deletions: it.deletions ?? 0,
    labels: labelsOf(it.labels), createdAt: it.created_at ?? "", updatedAt: it.updated_at ?? "", closedAt: it.closed_at, mergedAt: it.merged_at, mergedBy: it.merged_by,
    pipelineOn: f.tracked?.pipeline === true, ciChecks: pr ? ciChecksOf(f) : [], files: pr ? f.trace.detail.files.map((x) => ({ path: x.path, additions: x.additions, deletions: x.deletions })) : [],
    tier: extra.tier, discord: extra.discord, releases: extra.releases, queue: extra.slot,
    // The operator's instructions are shown to those who see the internals only.
    preapproval: pre && !staff ? { ...pre, instructions: "" } : pre,
  };
}

// ---- header and status -----------------------------------------------------------------------------------------------

function headerOf(c: Ctx, f: ItemPageFacts, it: Item, backlog: ItemPageHeader["backlog"]): ItemPageHeader {
  const lines = it.additions + it.deletions;
  const assignees = arr<string>(f.trace.detail.item?.assignees).filter((x) => typeof x === "string");
  return {
    labels: it.labels, assignees,
    autocraftAssigned: c.box !== "" && assignees.includes(c.box), pipelineOn: it.pipelineOn, discord: it.discord, queue: it.queue,
    held: f.trace.header.hold !== null,
    preapproval: it.kind === "pr" ? it.preapproval : null, releases: it.releases, tier: it.tier,
    size: it.kind !== "pr" ? null : lines < 50 ? "S" : lines < 300 ? "M" : lines < 1000 ? "L" : "XL",
    backlog,
  };
}

function statusOf(c: Ctx, f: ItemPageFacts, it: Item): ItemStatus {
  const stored = obj(f.trace.header.plan?.view).status as Partial<ItemStatus> | undefined;
  const since = it.mergedAt ?? it.closedAt ?? it.updatedAt ?? it.createdAt;
  const s = stored && typeof stored.phase === "string" ? ({ waiting: null, next: null, since, ...stored } as ItemStatus) : statusFromItem({ merged_at: it.mergedAt, closed_at: it.closedAt }, since);
  // A quiet pull request shows its viewers the phase only: the wait and next step quote the planner's reasons. A wait naming a hidden repo's item does not name it.
  return statusFor(itemReader(c), c.repo, c.n, s);
}

// ---- Opus reviews ------------------------------------------------------------------------------------------------------

const VERDICTS = new Set<string>(["take", "take-fix", "hold", "close"]);
type ReviewRow = { key: string; head_oid: string; at: string; model: string | null; verdict: string | null; sure: number | null; reason: string | null; summary: string | null; risks: unknown; fixes: unknown; claims: unknown; blocked_by: unknown; trigger: string | null };

function reviewsOf(c: Ctx, f: ItemPageFacts, headNow: string | null, events: Ev[]): ReviewHistory {
  const rec = f.trace.review;
  const rows: (ReviewRow & { rowid: number })[] = (rec?.history ?? []).filter((h) => h.verdict !== null).map((h) => ({
    key: `opus:${h.rowid}`, head_oid: h.head, at: h.at, model: h.model, verdict: h.verdict, sure: h.sure ? 1 : 0, reason: h.reason, summary: h.summary, risks: h.risks, fixes: h.fixes,
    claims: h.claims, blocked_by: h.blocked_by, trigger: h.trigger, rowid: h.rowid,
  }));
  // Reviews stored before the history table existed.
  const seen = new Set(rows.map((r) => `${r.head_oid}|${r.at}`));
  for (const l of rec?.reviews ?? [])
    if (l.verdict !== null && !seen.has(`${l.head}|${l.at}`)) rows.push({ key: `opus-latest:${l.head}`, head_oid: l.head, at: l.at, model: l.model, verdict: l.verdict, sure: l.sure ? 1 : 0, reason: l.reason, summary: null, risks: l.risks, fixes: l.fixes, claims: l.claims, blocked_by: null, trigger: null, rowid: 0 });
  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.rowid - a.rowid));
  const costs = new Map(events.filter((e) => e.kind === "review").map((e) => [e.id, e.costUsd ?? 0]));
  const staff = c.staff;
  const all = rows.map((r, i): OpusReviewEntry => {
    const older = rows[i + 1];
    // Rows from before the trigger was stored: the same head as the review before means the discussion moved.
    const trigger = (r.trigger && ["new-head", "discussion", "operator", "base"].includes(r.trigger) ? r.trigger : older && older.head_oid === r.head_oid ? "discussion" : "new-head") as ReviewTrigger;
    const fixes = arr<unknown>(r.fixes).map((x) => (typeof x === "string" ? x : `${(x as Json).file}: ${(x as Json).change}`));
    const claims = arr<Json>(r.claims).map((cl) => {
      // Claims are { claim, status, evidence }; the file and line sit in the evidence text.
      const m = /([\w./-]+\.\w+):(\d+)/.exec(String(cl.evidence ?? cl.claim ?? ""));
      return { path: m?.[1] ?? "", line: m ? Number(m[2]) : 0, text: String(cl.claim ?? cl.text ?? "") };
    }).filter((cl) => cl.text);
    return {
      id: r.key, head: short(r.head_oid), current: r.head_oid === headNow, at: r.at, trigger, why: staff ? triggerWhy(r.trigger, !older) ?? (older ? (trigger === "discussion" ? "New discussion since the last review" : "New commits since the last review") : "First review") : "",
      verdict: (VERDICTS.has(r.verdict ?? "") ? r.verdict : "hold") as ReviewVerdict, sure: r.sure === 1,
      summary: staff ? r.summary || r.reason || "" : "", fixes: staff ? fixes : [], risks: staff ? arr<string>(r.risks) : [], claims: staff ? claims : [],
      // Stored as "repo#n" strings.
      blockedBy: arr<unknown>(r.blocked_by).flatMap((b): ItemRef[] => {
        const m = typeof b === "string" ? /^([\w.-]+)#(\d+)$/.exec(b) : null;
        return m && !isHiddenRepo(c.hidden, m[1]!) ? [{ repo: m[1]!, number: Number(m[2]) }] : [];
      }),
      costUsd: costs.get(`review:${r.key}`) ?? 0,
    };
  });
  return { latest: all[0] ?? null, earlier: all.slice(1) };
}

// ---- GitHub side ---------------------------------------------------------------------------------------------------------

const IDENTITY: Record<string, string> = { legacy: "box account", app: "GitHub App" };
const asOf = (w: WriteRow | undefined): string => IDENTITY[w?.identity ?? "legacy"] ?? w?.identity ?? "box account";
const writeType = (action: string): GithubEvent["type"] =>
  action === "merge" ? "merged" : /-push$/.test(action) ? "push" : /^(labels-apply|act-unlabel|assign|unassign|label-create)$/.test(action) ? "label" : /^review-/.test(action) ? "review" : /close/.test(action) ? "closed" : "comment";

function githubOf(c: Ctx, f: ItemPageFacts, it: Item, ev: Ev[], url: string, syncedAt: string | null, ours: Set<string>): GithubSide {
  const events: GithubEvent[] = [];
  const d = f.trace.detail;
  const log = f.writeLog;
  const allWrites = matchWrites(log.filter((w) => w.action in GITHUB_ACTIONS), d.comments, ours);
  const writes = allWrites.filter((w) => w.state !== "failed");
  const pushed = pushedIn(log);
  const comments = d.comments.filter((m) => m.created_at !== null && !(m.kind === "review" && (m.body ?? "").trim() === ""));
  const summaryOf = new Map(ev.filter((e) => e.kind === "write").map((e) => [e.id, e.summary]));
  const byComment = new Map(writes.filter((w) => w.comment).map((w) => [w.comment!.id, w]));
  const used = new Set<number>();
  const own = c.own;
  if (it.createdAt) events.push({ id: "gh:opened", type: "opened", at: it.createdAt, actor: it.author, body: clean(it.body, 1500), autocraft: null });
  for (const m of comments) {
    const w = byComment.get(m.id);
    const mine = !!w || isOwnLogin(own, m.author);
    if (w) used.add(w.rowid);
    events.push({
      id: `comment:${m.id}`, type: m.kind === "review" ? "review" : "comment", at: m.created_at!, actor: mine ? "autocraft" : m.author ?? "unknown",
      body: clean(m.body ?? ""), autocraft: mine ? { as: asOf(w), historyId: w ? `audit:${w.rowid}` : `comment:${m.id}` } : null,
    });
  }
  const labelWrites = writes.filter((w) => w.action === "labels-apply" || w.action === "act-unlabel");
  for (const a of d.activity) {
    const mine = isOwnLogin(own, a.actor);
    const w = mine && a.kind !== "force-push" ? labelWrites.find((x) => Math.abs(Date.parse(x.at) - Date.parse(a.at)) <= MATCH_WINDOW_MS) : undefined;
    if (w) used.add(w.rowid);
    events.push({
      id: `activity:${a.id}`, type: a.kind === "force-push" ? "push" : "label", at: a.at, actor: mine ? "autocraft" : a.actor ?? "unknown",
      body: a.kind === "force-push" ? `Force-pushed ${short(a.before_oid)} → ${short(a.after_oid)}` : `${a.kind === "labeled" ? "Added" : "Removed"} label ${a.label ?? ""}`,
      autocraft: mine ? { as: asOf(w), historyId: w ? `audit:${w.rowid}` : `activity:${a.id}` } : null,
    });
  }
  const merged = writes.find((w) => w.action === "merge");
  if (it.mergedAt && !merged) events.push({ id: "gh:merged", type: "merged", at: it.mergedAt, actor: it.mergedBy ?? "unknown", body: null, autocraft: null });
  else if (it.closedAt && !it.mergedAt) events.push({ id: "gh:closed", type: "closed", at: it.closedAt, actor: "unknown", body: null, autocraft: null });
  // Writes without a mirrored comment or activity row: pushes, merges, assignments, closes, labels the sync has not read yet.
  for (const w of writes) {
    if (used.has(w.rowid) || (w.comment && w.action !== "merge")) continue;
    if (/comment|review-/.test(w.action) && !GITHUB_ACTIONS[w.action]) continue;
    events.push({ id: `audit:${w.rowid}`, type: writeType(w.action), at: w.at, actor: "autocraft", body: summaryOf.get(`audit:${w.rowid}`) ?? GITHUB_ACTIONS[w.action] ?? w.action, autocraft: { as: asOf(w), historyId: `audit:${w.rowid}` } });
  }
  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
  const commits = d.commits.map((m) => ({ oid: m.oid, message: m.message, author: m.author, at: m.committed_at < (m.first_seen_at ?? m.committed_at) ? m.committed_at : m.first_seen_at ?? m.committed_at }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.oid < b.oid ? -1 : 1))
    .map((m) => ({ sha: short(m.oid), message: clean(m.message ?? "", 500), author: m.author ?? "unknown", at: m.at, byAutoCraft: isOwnLogin(own, m.author) || pushed.has(m.oid) }));
  return {
    description: clean(it.body, 6000), events, checks: it.ciChecks.filter((x) => x.state !== "none").map((x) => ({ name: x.name, state: x.state })), commits,
    files: it.files.map((x) => ({ path: x.path, additions: x.additions, deletions: x.deletions })), url, syncedAt,
  };
}

// ---- screenshots -----------------------------------------------------------------------------------------------------

/** The latest screenshot run of the PR: one entry for staff, none for anyone else or a veiled PR. Images are served by the task artifact route. */
function screenshotsOf(c: Ctx, f: ItemPageFacts, headNow: string | null): ScreenshotRun[] {
  const r = f.screenshots[f.screenshots.length - 1];
  if (!c.staff || c.veiled || !r) return [];
  const names = (id: number | null): Set<string> => new Set(id === null ? [] : (f.screenshotArtifacts.get(id) ?? []).map((x) => x.name));
  const before = names(r.baseTaskId), after = names(r.headTaskId);
  const shots = [...after].filter((n) => before.has(n)).sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10))
    .map((name) => ({ name, before: { taskId: r.baseTaskId!, name }, after: { taskId: r.headTaskId!, name } }));
  return [{
    head: short(r.headSha), current: r.headSha === headNow, state: r.state as ScreenshotRun["state"], verdict: r.verdict as ScreenshotRun["verdict"], clear: r.clear,
    comparison: r.comparison === null ? null : String(r.comparison), held: r.held, reason: r.reason, model: r.model, at: r.finishedAt ?? r.createdAt, shots,
  }];
}

/** Our build of the newest head, as the page shows it: states only for viewers, hidden while the repo's switch is off. */
const prBuildOf = (c: Ctx, f: ItemPageFacts, on: boolean): ItemPrBuild | null => {
  const r = f.prBuild;
  if (!r || !on) return null;
  const state = r.state === "queued" ? (r.taskState === "claimed" || r.taskState === "running" ? "running" : "queued") : r.state;
  return { headSha: r.headSha, current: r.headSha === (f.trace.detail.item?.head_oid ?? null), state: state as ItemPrBuild["state"], summary: c.staff ? r.summary : null, disagree: r.disagree, ci: r.ciOverall, createdAt: r.createdAt, finishedAt: r.finishedAt };
};

// ---- the route -------------------------------------------------------------------------------------------------------------

export async function itemPage(db: Db, req: Req): Promise<ItemPageData | ItemPageUnchanged> {
  const ref = await visibleItem(db, req);
  // The stamp is read before the page, so it is never newer than the data it goes with, and an unchanged page costs only the stamp.
  // It and the parts the view does not read (the Discord counts, the releases, the queue slot) go out with the context, which decides whether they count.
  const stamped = Promise.all([
    contextScope(db, req).then((s) => loadItemStamp(db, s, ref)), discordOf(db, ref.repo, ref.number), releasesOf(db, ref.repo, ref.number),
    Promise.all([visibleRepos(db, req), computeStages(db)]).then(([v, stages]) => slotsOf(stages, v)), loadItems(db, [ref], "card"),
  ]);
  void stamped.catch(() => {});
  const c = await context(db, req);
  const scope = traceScope(c);
  const [[digest, discord0, releases0, slots0, card], canSettle] = await Promise.all([stamped, req.user.role === "viewer" ? false : mayRunRepo(req.user, c.repo)]);
  const stamp = createHash("sha1").update(JSON.stringify([c.staff, c.operator, c.hidden, c.veiled, ...digest, slots0.get(c.ref) ?? null, discord0, releases0, canSettle])).digest("hex").slice(0, 16);
  if (req.query.get("since") === stamp) return { unchanged: true, stamp };
  const author = card.get(c.ref)?.author;
  const [facts, cs] = await Promise.all([loadItemPage(db, scope, ref, writeActions(c.staff, c.operator)), author ? contributors(db, { login: author }) : []]);
  const detail = facts.trace.detail;
  const row = detail.item!;
  const it = itemOf(c, facts, { tier: TIER[cs.find((x) => x.login === author)?.tier ?? "not"] ?? "not", discord: discord0, releases: releases0, slot: slots0.get(c.ref) ?? null }, c.staff);
  const events = eventsFrom(c, facts.trace);
  const ev = shape(c, events, null);
  const status = statusOf(c, facts, it);
  const prBuildsOn = (facts.prBuild !== null || row.kind === "pr") && await featureOn(db, "pr-builds", c.repo);
  const headNow = row.head_oid;
  const backlog = { held: facts.workflow[facts.workflow.length - 1]?.state === "backlog", canSettle };
  const impl = implementationFrom(facts.implementation);
  const pre = it.kind === "pr" ? facts.legs.map(legView).map((p) => (c.staff ? p : { ...p, instructions: "" })) : [];
  const costUsd = facts.trace.runs.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const ours = c.own;
  return {
    repo: c.repo, number: c.n, kind: it.kind, state: it.state, title: it.title, author: it.author, stamp,
    header: headerOf(c, facts, it, backlog), status, bar: barOf(c, { kind: it.kind, state: it.state, mergedAt: it.mergedAt, pipelineOn: it.pipelineOn }, status, facts), costUsd,
    reviews: it.kind === "pr" ? reviewsOf(c, facts, headNow, ev) : { latest: null, earlier: [] },
    timeline: timelineOf(c, ev, pre, impl, facts, prBuildsOn).slice(-200),
    github: githubOf(c, facts, it, ev, row.url ?? "", detail.read, ours),
    prBuild: row.kind === "pr" ? prBuildOf(c, facts, prBuildsOn) : null,
    screenshots: screenshotsOf(c, facts, headNow),
    implementation: implementationView(c, impl, facts.implementationPr),
  };
}
