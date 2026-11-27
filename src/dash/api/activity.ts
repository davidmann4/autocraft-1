// The activity stream: the item trace's event rows for all items together, newest first. Each source reads only its newest
// rows by time (src/data/views/activity.ts), the sources are merged and cut to the page, and the cursor is time + id. The row to
// event mapping is the item trace's (trace.ts).
import { createHash } from "node:crypto";
import type { ActivityEvent, ActivityItem, ActivityPage, TraceKind } from "../../../web/src/api/types.ts";
import { loadShown } from "../../data/mirror/index.ts";
import { loadQuiet } from "../../data/security/index.ts";
import { loadActivityRound, loadActivityStamp, sourcesOf, type ActivityRow, type ActivityScope } from "../../data/views/activity.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import {
  KINDS, activityEvent, writeActions, writeEvent, checkEvent, ciFixEvent, closedEvent, commentEvent, conflictEvent, fixupEvent, iso, jobEvent, mergeEvent, mergedEvent, openedEvent,
  opusEvent, patchCheckEvent, planEventFor, postmergeEvent, premergeEvent, pushEvent, runEvent, stageEvent, taskEvent, turnEvent, verifyEvent, workflowEvent, plainSummary, veilEvent,
  VEILED_KINDS, type Ev,
} from "./trace.ts";
import { canSeeInternals } from "./staff.ts";
import { hiddenRepos, needVisible, visibleRepos } from "./visible.ts";
import { allOwnLogins } from "../../github/identity.ts";
import type { Db } from "../../db/index.ts";

export const ACTIVITY_PAGE_DEFAULT = 50, ACTIVITY_PAGE_MAX = 200;
/** Plan changes and stages come from every planner pass of every item and would bury the rest, so they show only when asked for. Discord mentions are listed per item only. */
export const ACTIVITY_DEFAULT_KINDS: TraceKind[] = KINDS.filter((k) => k !== "plan" && k !== "discord");
/** Sorts after every event id of the same time. */
const LAST = "~";

type At = { repo: string; number: number };
type Ctx = { own: Set<string>; staff: boolean; hidden: ActivityScope["hidden"] };
type Round = { staff: boolean; operator: boolean; hidden: ActivityScope["hidden"]; own: Set<string>; visible: string[]; repo: string | null; limit: number; only: boolean; before: { at: string; id: string } | null };

/** The events of one stored row of each source. */
const MAP: Record<string, (r: ActivityRow, c: Ctx) => (Ev | null)[]> = {
  opened: (r) => [openedEvent(r as never)], merged: (r) => [mergedEvent(r as never)], closed: (r) => [closedEvent(r as never)],
  comment: (r, c) => [commentEvent(r as never, c.own)], activity: (r, c) => [activityEvent(r as never, c.own)], stage: (r) => [stageEvent(r as never)],
  plan: (r, c) => [planEventFor(c, r as never)], job: (r) => [jobEvent(r as never)],
  run: (r, c) => [runEvent({ ...(r as never as Parameters<typeof runEvent>[0]), label: null }, c.staff)],
  check: (r) => [checkEvent(r as never)], task: (r) => [taskEvent(r as never)], push: (r) => [pushEvent(r as never)], patchcheck: (r) => [patchCheckEvent(r as never)],
  opus: (r) => [opusEvent(r as never, `opus:${r.rowid}`)], premerge: (r) => [premergeEvent(r as never)], postmerge: (r, c) => [postmergeEvent(r as never, c.staff)], verify: (r) => [verifyEvent(r as never)],
  workflow: (r, c) => [workflowEvent(r as never, c)],
  fixup: (r) => [fixupEvent(r as never)], cifix: (r) => [ciFixEvent(r as never)], conflict: (r) => [conflictEvent(r as never)], merge: (r) => [mergeEvent(r as never)],
  turn: (r) => [turnEvent(r as never)], write: (r, c) => [writeEvent(r as never, c.staff)],
};

const after = (a: Ev, b: { at: string; id: string }): boolean => a.at < b.at || (a.at === b.at && a.id < b.id);

/** One round: every wanted source's newest rows before the cursor, merged. Events older than the oldest row of a source that hit its limit may be missing others of that source, so they wait for the next round. */
async function round(db: Db, c: Round, kinds: Set<TraceKind>): Promise<{ events: (Ev & At)[]; bound: string | null }> {
  const scope: ActivityScope = { staff: c.staff, operator: c.operator, hidden: c.hidden, own: c.own, repos: c.visible };
  const { bySource } = await loadActivityRound(db, scope, { kinds, only: c.only, repo: c.repo, limit: c.limit, before: c.before, writeActions: writeActions(c.staff, c.operator) });
  const events: (Ev & At)[] = [];
  let bound: string | null = null;
  for (const s of bySource) {
    if (s.floor && (!bound || s.floor > bound)) bound = s.floor;
    for (const row of s.rows)
      for (const e of MAP[s.source]!(row, c)) {
        const at = e && iso(e.at);
        if (e && at) events.push({ ...e, at, repo: row.repo, number: row.number });
      }
  }
  const kept = events.filter((e) => (!bound || e.at >= bound) && (!c.before || after(e, c.before)));
  return { events: kept.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1)), bound };
}

type Query = { kinds: Set<TraceKind>; only: boolean; repo: string | null; limit: number; cursor: { at: string; id: string } | null };

async function page(db: Db, base: Omit<Round, "before" | "limit" | "only">, q: Query): Promise<{ events: (Ev & At)[]; next: { at: string; id: string } | null }> {
  const out: (Ev & At)[] = [];
  const ids = new Set<string>();
  let before = q.cursor;
  let exhausted = false;
  // The autocraft filter drops rows after the read, so a round can come back short: read on, a few rounds at most.
  for (let i = 0; i < 6 && !exhausted && out.length <= q.limit; i++) {
    const { events, bound } = await round(db, { ...base, limit: q.limit, only: q.only, before }, q.kinds);
    for (const e of events) {
      const key = `${e.repo}#${e.number}|${e.id}`;
      if (ids.has(key) || (q.only && e.actor.type === "person")) continue;
      ids.add(key);
      out.push(e);
    }
    if (!bound) exhausted = true;
    // The next round starts at the oldest time that was fully read; when a whole round sat in one second, step past it.
    else before = { at: before && bound >= before.at ? new Date(Date.parse(before.at) - 1).toISOString() : bound, id: LAST };
  }
  const events = out.slice(0, q.limit);
  return { events, next: out.length > q.limit ? tail(events, q.limit) : exhausted ? null : before };
}
const tail = (events: Ev[], limit: number): { at: string; id: string } | null => {
  const last = events[limit - 1];
  return last ? { at: last.at, id: last.id } : null;
};

/** The page's items from one read after the final merge. */
const itemsOf = async (db: Db, events: (Ev & At)[]): Promise<Map<string, ActivityItem>> => {
  const shown = await loadShown(db, [...new Map(events.map((e) => [`${e.repo}#${e.number}`, { repo: e.repo, number: e.number }])).values()]);
  const out = new Map<string, ActivityItem>();
  for (const e of events) {
    const k = `${e.repo}#${e.number}`;
    const r = shown.get(k);
    if (!out.has(k)) out.set(k, { repo: e.repo, number: e.number, kind: r?.kind ?? null, state: r?.state ?? null, title: r?.title ?? null });
  }
  return out;
};

export async function activity(db: Db, req: Req): Promise<ActivityPage | { unchanged: true; stamp: string }> {
  const q = (k: string) => req.query.get(k) || undefined;
  const limitRaw = q("limit");
  if (limitRaw !== undefined && !/^\d{1,4}$/.test(limitRaw)) throw new HttpError(400, "limit must be a whole number");
  const limit = Math.min(Math.max(Number(limitRaw ?? ACTIVITY_PAGE_DEFAULT), 1), ACTIVITY_PAGE_MAX);
  const kq = q("kinds");
  let kinds = new Set(ACTIVITY_DEFAULT_KINDS);
  if (kq) {
    const list = kq.split(",");
    if (list.some((k) => !KINDS.includes(k as TraceKind))) throw new HttpError(400, `kinds are ${KINDS.join(", ")}`);
    kinds = new Set(list as TraceKind[]);
  }
  const only = q("autocraftOnly") === "1" || q("autocraftOnly") === "true";
  const repo = q("repo") ?? null;
  if (repo) await needVisible(db, req, repo);
  const cq = q("cursor");
  let cursor: { at: string; id: string } | null = null;
  if (cq) {
    const i = cq.indexOf("|");
    const at = i < 1 ? null : iso(cq.slice(0, i));
    if (!at) throw new HttpError(400, "bad cursor");
    cursor = { at, id: cq.slice(i + 1) };
  }
  const wanted = sourcesOf(kinds);
  const [hidden, visible, own, digest] = await Promise.all([hiddenRepos(db, req), visibleRepos(db, req), allOwnLogins(db), loadActivityStamp(db, { kinds, repo })]);
  const base = { staff: canSeeInternals(req), operator: req.user.role === "operator", hidden, visible, repo, own };
  const stamp = createHash("sha1").update(JSON.stringify([[...kinds].sort(), only, repo, limit, base.staff, base.operator, base.visible, wanted.map((s) => s.id), digest])).digest("hex").slice(0, 16);
  // `since` applies to the first page; a later page is always read.
  if (!cursor && q("since") === stamp) return { unchanged: true, stamp };
  const { events, next } = await page(db, base, { kinds, only, repo, limit, cursor });
  const refs = [...new Set(events.map((e) => `${e.repo}#${e.number}`))];
  // Viewers get no model or failure text: quiet pull requests lose the model-written kinds, every summary is cut to its plain part.
  const [info, quiet] = await Promise.all([itemsOf(db, events), base.staff ? new Set<string>() : loadQuiet(db, refs)]);
  const shown: typeof events = base.staff ? events : events.flatMap((e) => {
    const isQuiet = quiet.has(`${e.repo}#${e.number}`);
    if (isQuiet && VEILED_KINDS.includes(e.kind)) return [];
    const v = isQuiet ? veilEvent(e) : e;
    return [{ ...v, repo: e.repo, number: e.number, summary: plainSummary(v) }];
  });
  const out: ActivityEvent[] = shown.map(({ detail: _d, repo: r, number: n, ...e }) => ({ ...e, item: info.get(`${r}#${n}`)! }));
  return { events: out, nextCursor: next ? `${next.at}|${next.id}` : null, stamp };
}
