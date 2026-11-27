// Pure rules of the outside-author budgets; no handle (M15 intake part).
import { isBotLogin } from "../../review/bots.ts";
import { DAY_MS, HOUR_MS, MAX_LIMIT, authorKey } from "./constants.ts";
import { OutsideError } from "./types.ts";
import type { AuthorRef, Candidate, Hold, HoldInfo, HoldInput, HoldResult, OutsideAuthorRow, OutsideLimits } from "./types.ts";

const INSIDE_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** GitHub Bot authors: the mirror's author type, or (rows synced before it was stored) a `[bot]` suffix or a known app login (the mirror stores app logins without the suffix). */
const isBotAuthor = (r: { author: string; author_type: string | null }): boolean =>
  r.author_type === "Bot" || (r.author_type === null && (isBotLogin(r.author) || r.author.toLowerCase() === "github-actions")) || r.author.endsWith("[bot]");

/** Whether a PR or issue row is by an outside author: not a collaborator by association, not a bot, not an operator, maintainer or own pipeline login. */
export function isOutsideAuthor(row: OutsideAuthorRow, insiders: ReadonlySet<string>): boolean {
  if (!row.author) return false;
  return !INSIDE_ASSOCIATIONS.has(row.author_association ?? "") && !isBotAuthor({ author: row.author, author_type: row.author_type }) && !insiders.has(row.author.toLowerCase());
}

/** The wait text of a held item (the registered wait "author over daily limit", and the surge variant). */
export function holdWait(h: Pick<HoldInfo, "reason" | "kind" | "limit">): string {
  return h.reason === "surge" ? "the outside-surge breaker, until an operator resumes it" : `author's daily limit (${h.limit} new ${h.kind === "pr" ? "PRs" : "issues"} a day)`;
}

/** The three numbers of a save (0 turns a protection off); a key left out keeps its value in `was`. */
export function parseOutsideLimits(input: unknown, was: OutsideLimits): OutsideLimits {
  const b = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const next = { ...was };
  for (const k of Object.keys(was) as (keyof OutsideLimits)[]) {
    const v = b[k];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_LIMIT) throw new OutsideError(`${k} must be a whole number from 0 to ${MAX_LIMIT}`);
    next[k] = v;
  }
  return next;
}

const enabled = (l: OutsideLimits): boolean => l.prsPerDay > 0 || l.issuesPerDay > 0 || l.surgePerHour > 0;
const ms = (t: string): number => Date.parse(t);

type Group = { rs: Candidate[]; kind: "pr" | "issue"; limit: number; win: Candidate[]; overLimit: boolean; inSurge: boolean };

function groupsOf(rows: Candidate[], l: OutsideLimits, now: number, surgeFrom: number | null): Group[] {
  const by = new Map<string, Candidate[]>();
  for (const r of rows) {
    const k = `${authorKey(r.author, r.author_id)}|${r.kind}`;
    (by.get(k) ?? by.set(k, []).get(k)!).push(r);
  }
  const dayAgo = now - DAY_MS;
  return [...by.values()].map((rs) => {
    rs.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.number - b.number);
    const kind = rs[0]!.kind === "pr" ? "pr" as const : "issue" as const;
    const limit = kind === "pr" ? l.prsPerDay : l.issuesPerDay;
    const win = rs.filter((r) => ms(r.created_at) >= dayAgo);
    return { rs, kind, limit, win, overLimit: limit > 0 && win.length > limit, inSurge: surgeFrom !== null && rs.some((r) => ms(r.created_at) >= surgeFrom) };
  }).filter((g) => g.overLimit || g.inSurge);
}

/** The items created since the breaker last cleared, within the last hour. */
function recentOf(input: HoldInput): Candidate[] {
  const since = Math.max(input.nowMs - HOUR_MS, ms(input.trip?.clearedAt ?? "") || 0);
  return input.rows.filter((r) => ms(r.created_at) > since);
}

const surgeFromOf = (input: HoldInput): number | null => (input.limits.surgePerHour > 0 && input.trip?.active ? ms(input.trip.trippedAt) - HOUR_MS : null);

/**
 * The authors whose whitelist verdict `computeHolds` may read: those of the recent items when their count passes the surge
 * threshold, and those of the groups over their daily limit or created in a surge (also as a surge started by this pass would
 * see them). A superset of what the rule reads, so one load of verdicts serves it.
 */
export function holdAuthors(input: HoldInput): AuthorRef[] {
  const { limits, nowMs } = input;
  if (!enabled(limits)) return [];
  const out = new Map<string, AuthorRef>();
  const add = (r: Candidate) => { const k = authorKey(r.author, r.author_id); if (!out.has(k)) out.set(k, { login: r.author, id: r.author_id }); };
  let surgeFrom = surgeFromOf(input);
  if (limits.surgePerHour > 0 && !input.trip?.active) {
    const recent = recentOf(input);
    if (recent.length > limits.surgePerHour) {
      recent.forEach(add);
      surgeFrom = nowMs - HOUR_MS;
    }
  }
  for (const g of groupsOf(input.rows, limits, nowMs, surgeFrom)) add(g.rs[0]!);
  return [...out.values()];
}

/**
 * The rule. Decides the surge trip, the holds, `wakeAt` and the admissions from the in-scope items of outside authors. An
 * author in `whitelisted` (authorKey of the first item) is never held and does not count toward a surge. A surge tripped by
 * this pass holds as a trip written at `nowMs` would: items created from an hour before it.
 */
export function computeHolds(input: HoldInput): HoldResult {
  const { rows, limits, nowMs: now, whitelisted } = input;
  const none: HoldResult = { holds: [], admissions: [], wakeAt: null, tripSurge: null };
  if (!enabled(limits)) return none;
  const ok = (r: Candidate): boolean => whitelisted.has(authorKey(r.author, r.author_id));
  let surgeFrom = surgeFromOf(input);
  let tripSurge: HoldResult["tripSurge"] = null;
  if (limits.surgePerHour > 0 && !input.trip?.active) {
    const recent = recentOf(input);
    const real = recent.length > limits.surgePerHour ? recent.filter((r) => !ok(r)) : [];
    if (real.length > limits.surgePerHour) {
      const byAuthor = new Map<string, number>();
      for (const r of real) byAuthor.set(r.author, (byAuthor.get(r.author) ?? 0) + 1);
      const top = [...byAuthor].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a, n]) => `${a}: ${n}`);
      tripSurge = { reason: `${real.length} new items from outside authors in the last hour (more than ${limits.surgePerHour})`, evidence: top };
      surgeFrom = now - HOUR_MS;
    }
  }
  const holds: Hold[] = [];
  let wakeAt: number | null = null;
  for (const { rs, kind, limit, win, overLimit } of groupsOf(rows, limits, now, surgeFrom)) {
    if (ok(rs[0]!)) continue;
    // An admitted item (planned without a hold once) is never held again; a released one is exempt; a closed one needs no hold.
    const free = (r: Candidate) => r.state !== "OPEN" || r.released || r.admitted;
    for (const r of rs) if (!free(r) && surgeFrom !== null && ms(r.created_at) >= surgeFrom) holds.push({ repo: r.repo, number: r.number, author: r.author, kind, reason: "surge" });
    const surged = new Set(holds.map((h) => `${h.repo}#${h.number}`));
    win.forEach((r, i) => {
      if (overLimit && i >= limit && !free(r) && !surged.has(`${r.repo}#${r.number}`)) holds.push({ repo: r.repo, number: r.number, author: r.author, kind, reason: "limit" });
    });
    if (overLimit) { const t = ms(win[0]!.created_at) + DAY_MS; wakeAt = wakeAt === null ? t : Math.min(wakeAt, t); }
  }
  const held = new Set(holds.map((h) => `${h.repo}#${h.number}`));
  const admissions = rows.filter((r) => !held.has(`${r.repo}#${r.number}`) && !r.admitted).map((r) => ({ repo: r.repo, number: r.number }));
  return { holds, admissions, wakeAt, tripSurge };
}
