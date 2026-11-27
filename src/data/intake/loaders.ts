// Loaders and read models (M15 intake part).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { resolveKeys, type KeySource, type Ref } from "../keys.ts";
import { loginsWithRole, loadOwnLogins } from "../access/index.ts";
import { hiddenRepos } from "../control/fragments.ts";
import { filtered, loadTrip } from "../control/index.ts";
import { loadItems } from "../mirror/index.ts";
import { limitsOf } from "./limits.ts";
import { OUTSIDE_SURGE } from "./types.ts";
import { isOutsideAuthor } from "./pure.ts";
import type { HeldAuthorRow, HiddenRepos, HoldCounts, HoldInfo, HoldReason, HoldStatus, OutsideAuthorRow, OutsideState, RefKey } from "./types.ts";

const empty = (keys: KeySource): boolean => Array.isArray(keys) && keys.length === 0;
const refKey = (r: { repo: string; number: number }): RefKey => `${r.repo}#${r.number}`;

/** Hold of each item; `limit` comes from the settings snapshot. 1 statement, joining the caller's wave. */
export async function loadHolds(db: Db, keys: KeySource): Promise<Map<RefKey, HoldInfo>> {
  if (empty(keys)) return new Map();
  const q = queryDb(db);
  const k = q.k as any;
  const [rows, lim] = await Promise.all([
    q.all(k.selectFrom("main.outside_holds as h").innerJoin(resolveKeys(db, keys, "kk"), (j: any) => j.onRef("kk.repo", "=", "h.repo").onRef("kk.number", "=", "h.number"))
      .select(["h.repo", "h.number", "h.author", "h.kind", "h.reason"])) as Promise<{ repo: string; number: number; author: string; kind: "pr" | "issue"; reason: HoldReason }[]>,
    limitsOf(db),
  ]);
  return new Map(rows.map((h) => [refKey(h), { reason: h.reason, author: h.author, kind: h.kind, limit: h.kind === "pr" ? lim.prsPerDay : lim.issuesPerDay }]));
}

/** Hold row and release row per item (item page, list rows); one statement with two left joins. A held item shows its hold. */
export async function loadHoldStatus(db: Db, keys: KeySource): Promise<Map<RefKey, HoldStatus>> {
  const out = new Map<RefKey, HoldStatus>();
  if (empty(keys)) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const rows = await q.all(k.selectFrom(resolveKeys(db, keys, "kk"))
    .leftJoin("main.outside_holds as h", (j: any) => j.onRef("h.repo", "=", "kk.repo").onRef("h.number", "=", "kk.number"))
    .leftJoin("main.outside_released as r", (j: any) => j.onRef("r.repo", "=", "kk.repo").onRef("r.number", "=", "kk.number"))
    .select(["kk.repo as repo", "kk.number as number", "h.author as author", "h.reason as reason", "r.by as released_by"])
    .where((eb: any) => eb.or([eb("h.repo", "is not", null), eb("r.repo", "is not", null)]))) as { repo: string; number: number; author: string | null; reason: HoldReason | null; released_by: string | null }[];
  for (const r of rows) {
    const key = refKey(r);
    if (r.author !== null && r.reason !== null) out.set(key, { author: r.author, reason: r.reason, releasedBy: null });
    else if (r.released_by !== null) out.set(key, { author: null, reason: null, releasedBy: r.released_by });
  }
  return out;
}

/** Per author (one spelling, the smallest): count, PRs, oldest item and surge flag, most items first. 2 statements in 2 waves. */
export async function listHeldAuthors(db: Db, filter: { hidden: HiddenRepos }): Promise<HeldAuthorRow[]> {
  const q = queryDb(db);
  const k = q.k as any;
  const holds = await q.all(k.selectFrom("main.outside_holds as h").select(["h.repo", "h.number", "h.author", "h.kind", "h.reason"])
    .$if(filtered(filter.hidden), (s: any) => s.where(hiddenRepos(db, "h.repo", filter.hidden)))) as { repo: string; number: number; author: string; kind: string; reason: string }[];
  if (holds.length === 0) return [];
  const items = await loadItems(db, holds.map((h): Ref => ({ repo: h.repo, number: h.number })), "card");
  const by = new Map<string, HeldAuthorRow>();
  for (const h of holds) {
    const g = by.get(h.author.toLowerCase()) ?? by.set(h.author.toLowerCase(), { author: h.author, count: 0, prs: 0, oldest: null, surge: false }).get(h.author.toLowerCase())!;
    const at = items.get(refKey(h))?.created_at ?? null;
    g.author = h.author < g.author ? h.author : g.author;
    g.count++;
    if (h.kind === "pr") g.prs++;
    if (at !== null && (g.oldest === null || at < g.oldest)) g.oldest = at;
    if (h.reason === "surge") g.surge = true;
  }
  return [...by.values()].sort((a, b) => b.count - a.count || (a.author < b.author ? -1 : a.author > b.author ? 1 : 0));
}

/** Held counts: by reason and distinct authors (without case), optionally narrowed to one reason. 1 statement. */
export async function countHolds(db: Db, filter: { hidden?: HiddenRepos; reason?: HoldReason }): Promise<HoldCounts> {
  const q = queryDb(db);
  const k = q.k as any;
  const c = await q.get(k.selectFrom("main.outside_holds as h").select((eb: any) => [
    eb.fn.sum(eb.case().when("h.reason", "=", "limit").then(1).else(0).end()).as("l"),
    eb.fn.sum(eb.case().when("h.reason", "=", "surge").then(1).else(0).end()).as("s"),
    eb.fn.count("h.author").distinct().as("a"),
  ])
    .$if(!!filter.hidden && filtered(filter.hidden), (s: any) => s.where(hiddenRepos(db, "h.repo", filter.hidden!)))
    .$if(!!filter.reason, (s: any) => s.where("h.reason", "=", filter.reason))) as { l: number | string | null; s: number | string | null; a: number | string };
  return { limit: Number(c.l ?? 0), surge: Number(c.s ?? 0), authors: Number(c.a) };
}

/** Counts plus the breaker, in one wave. */
export async function loadOutsideState(db: Db, hidden: HiddenRepos): Promise<OutsideState> {
  const [counts, trip, lim] = await db.together(() => Promise.all([countHolds(db, { hidden }), loadTrip(db, OUTSIDE_SURGE), limitsOf(db)]));
  return { ...lim, heldByLimit: counts.limit, heldBySurge: counts.surge, authors: counts.authors, tripped: trip?.active ? { reason: trip.reason, since: trip.trippedAt } : null };
}

/** Operators, maintainers and own logins, lower case. */
export async function loadInsiders(db: Db): Promise<Set<string>> {
  const [staff, own] = await db.together(() => Promise.all([loginsWithRole(db, ["operator", "maintainer"]), loadOwnLogins(db)]));
  return new Set([...staff.map((l) => l.toLowerCase()), ...[...own].map((l) => l.toLowerCase())]);
}

/** The refs among the rows whose author is outside. */
export async function loadOutsideFlags(db: Db, rows: (OutsideAuthorRow & { repo: string; number: number })[]): Promise<Set<RefKey>> {
  if (rows.length === 0) return new Set();
  const insiders = await loadInsiders(db);
  return new Set(rows.filter((r) => isOutsideAuthor(r, insiders)).map(refKey));
}
