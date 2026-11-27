// Duplicate groups, their comparison sets and which sets are due, as pure functions over `DupeState` (loadDupeState).
// Items joined by duplicate pairs form a group; the members of one kind (PRs, issues) are compared together in one call, and the
// stored result is current while no member's state has changed, no member joined or left, no issue's text has changed and no
// PR's diff size has moved by more than 20% since the compared head.
import { createHash } from "node:crypto";
import type { DupeEdge, DupeMember, DupeState, PrDuplicates, RefKey } from "./types.ts";

export type DupeKind = "pr" | "issue";
export type DupeGroup = { repo: string; members: number[]; edges: DupeEdge[] };
/** The members of one kind of a group: what one comparison covers. */
export type KindSet = { repo: string; kind: DupeKind; key: string; members: DupeMember[]; hash: string };
type StoredRow = DupeState["comparisons"] extends Map<string, infer R> ? R : never;

export const DIFF_SIZE_CHANGE = 0.2;
export const DROP_PAUSE_MS = 10 * 60_000;
export const RULE_RETRY_MS = 15 * 60_000;
export const RULE_ATTEMPTS = 3;

/** How a set is settled without a model call: a closed or merged member wins, a lone member is kept; null when a model compares it. */
export const ruleOutcome = (s: { members: { state: string }[] }): "closed" | "single" | null =>
  s.members.some((m) => m.state !== "OPEN") ? "closed" : s.members.length < 2 ? "single" : null;

export const setKey = (kind: DupeKind, numbers: number[]): string => `${kind}:${[...numbers].sort((a, b) => a - b).join(",")}`;

/** Changes whenever a member's state does, an issue's text, or the issues a PR closes; a PR's head and other text are left out (its diff size is checked on its own). */
export function setHash(members: DupeMember[]): string {
  const rows = [...members].sort((a, b) => a.number - b.number).map((m) => (m.kind === "pr" ? [m.number, m.state, m.closing_issues] : [m.number, m.state, m.embed_hash]));
  return createHash("sha1").update(JSON.stringify(rows)).digest("hex");
}

/** The hash rows stored before diff sizes were kept carry: state, head commit and text of every member. */
function legacySetHash(members: DupeMember[]): string {
  const rows = [...members].sort((a, b) => a.number - b.number).map((m) => [m.number, m.state, m.head_oid, m.embed_hash]);
  return createHash("sha1").update(JSON.stringify(rows)).digest("hex");
}

const sizeOf = (m: { additions: number | null; deletions: number | null }): number | null => (m.additions === null || m.deletions === null ? null : m.additions + m.deletions);

/** The connected components of the duplicate edges, members ascending. */
export function dupeGroups(state: Pick<DupeState, "edges">): DupeGroup[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const e of state.edges) {
    for (const n of [e.a, e.b]) if (!parent.has(`${e.repo}#${n}`)) parent.set(`${e.repo}#${n}`, `${e.repo}#${n}`);
    parent.set(find(`${e.repo}#${e.a}`), find(`${e.repo}#${e.b}`));
  }
  const by = new Map<string, DupeEdge[]>();
  for (const e of state.edges) {
    const root = find(`${e.repo}#${e.a}`);
    (by.get(root) ?? by.set(root, []).get(root)!).push(e);
  }
  return [...by.values()].map((es) => ({ repo: es[0]!.repo, members: [...new Set(es.flatMap((e) => [e.a, e.b]))].sort((x, y) => x - y), edges: es }));
}

/** The kind sets of a group. Left out: members not in the mirror, closed unmerged PRs, items closed as duplicates. */
export function kindSets(state: Pick<DupeState, "members">, g: DupeGroup): KindSet[] {
  const members = g.members.flatMap((n): DupeMember[] => {
    const m = state.members.get(`${g.repo}#${n}`);
    if (!m || (m.kind === "pr" && m.state === "CLOSED") || m.state_reason === "DUPLICATE") return [];
    return [m];
  });
  return (["pr", "issue"] as const).flatMap((kind) => {
    const ms = members.filter((m) => m.kind === kind);
    return ms.length ? [{ repo: g.repo, kind, key: setKey(kind, ms.map((m) => m.number)), members: ms, hash: setHash(ms) }] : [];
  });
}

/** True when a PR member's diff size differs by more than 20% from the size stored at compare time; a size unknown then counts as moved once known. */
function diffMoved(c: StoredRow, members: DupeMember[]): boolean {
  let at: Record<string, number>;
  try { at = JSON.parse(c.sizes ?? "{}") as Record<string, number>; } catch { return false; }
  return members.some((m) => {
    const then = at[m.number], now = sizeOf(m);
    if (now === null) return false;
    return then === undefined || Math.abs(now - then) > DIFF_SIZE_CHANGE * Math.max(then, 1);
  });
}

/** The stored comparison of the set when it is current, else null. */
export function currentComparison(state: Pick<DupeState, "comparisons">, s: KindSet): StoredRow | null {
  const c = state.comparisons.get(`${s.repo}\n${s.key}`);
  if (!c) return null;
  if (c.hash === s.hash) return diffMoved(c, s.members) ? null : c;
  return c.sizes == null && c.hash === legacySetHash(s.members) ? c : null;
}

/** When the set's current snapshot was last dropped (it changed on GitHub since the sync), in ms, or null. */
function droppedAt(state: Pick<DupeState, "drops">, s: KindSet): number | null {
  const d = state.drops.get(`${s.repo}\n${s.key}`);
  return d && d.hash === s.hash ? Date.parse(d.at) : null;
}

/**
 * Sets that need a comparison: an open member is in scope, no current result is stored (or a rule result may be tried again: after
 * 15 minutes, three times at most), and the set did not just change on GitHub. `dueAt` holds, per member ref, the earliest time a
 * set's answer changes with the clock alone (a rule result's retry wait or a drop's pause ends).
 */
export function dueSets(state: DupeState, nowMs: number): { sets: KindSet[]; dueAt: Map<RefKey, number> } {
  const sets: KindSet[] = [];
  const dueAt = new Map<RefKey, number>();
  const soon = (s: KindSet, at: number): void => {
    if (at <= nowMs) return;
    for (const m of s.members) {
      const k = `${s.repo}#${m.number}`, was = dueAt.get(k);
      if (was === undefined || at < was) dueAt.set(k, at);
    }
  };
  for (const g of dupeGroups(state))
    for (const s of kindSets(state, g)) {
      if (!s.members.some((m) => m.state === "OPEN" && m.in_scope)) continue;
      const c = currentComparison(state, s);
      if (c && c.source === "rule" && c.attempts < RULE_ATTEMPTS) soon(s, Date.parse(c.at) + RULE_RETRY_MS);
      const dropped = droppedAt(state, s);
      if (dropped !== null) soon(s, dropped + DROP_PAUSE_MS);
      const retry = !!c && c.source === "rule" && c.attempts < RULE_ATTEMPTS && nowMs - Date.parse(c.at) >= RULE_RETRY_MS;
      if ((!c || retry) && !(dropped !== null && nowMs - dropped < DROP_PAUSE_MS)) sets.push(s);
    }
  return { sets, dueAt };
}

/** Per member ref of the due sets, how its set is compared: "model" wins over "rule" when a ref is in both kinds of set. */
export function compareOf(sets: KindSet[]): Map<RefKey, "rule" | "model"> {
  const out = new Map<RefKey, "rule" | "model">();
  for (const s of sets) {
    const how = ruleOutcome(s) === null ? "model" : "rule";
    for (const m of s.members) {
      const ref = `${s.repo}#${m.number}`;
      if (out.get(ref) !== "model") out.set(ref, how);
    }
  }
  return out;
}

/** Whether a person ruled on the pair, at any text: no check or comparison makes the two duplicates of each other. */
function ruledOn(x: DupeMember, y: DupeMember): boolean {
  const [a, b] = x.number < y.number ? [x, y] : [y, x];
  return !!a.ruled && a.ruled.split(",").includes(String(b.number));
}

/**
 * Per PR of a model's comparison, the best one of those it duplicates (itself when it is the best): a PR the comparison found to be
 * no duplicate leads the PRs that lost to it in an earlier round.
 */
function bestOf(c: StoredRow): (n: number) => number {
  type Other = { number: number; duplicate?: boolean; via?: number };
  let others: Other[] = [];
  try { others = (JSON.parse(c.result ?? "null") as { others?: Other[] } | null)?.others ?? []; } catch { /* no answers: every PR duplicates the kept one */ }
  const by = new Map(others.map((o) => [o.number, o]));
  return (n) => {
    const seen = new Set<number>();
    for (let at = n; ; ) {
      if (at === c.kept || seen.has(at)) return at;
      seen.add(at);
      const o = by.get(at);
      if (o?.duplicate === false) return at;
      at = o?.via ?? c.kept;
    }
  };
}

/**
 * The open PRs that duplicate another open or merged PR, for the steps nobody started. A model's comparison of the group decides:
 * its best PR is free while nobody started one of those that duplicate it, and a PR it found to be no duplicate is free. Every
 * other outcome (a merged PR won, no valid answer) names no best one among the open PRs, so each of them duplicates the rest; so do
 * the checked pairs of a group that was not compared since a member came, merged or closed. Closed unmerged PRs count for nothing.
 */
export function prDuplicates(state: Pick<DupeState, "edges" | "members" | "comparisons">): Map<RefKey, PrDuplicates> {
  const out = new Map<RefKey, PrDuplicates>();
  for (const g of dupeGroups(state)) {
    const set = kindSets(state, g).find((s) => s.kind === "pr");
    if (!set || set.members.length < 2) continue;
    // A diff that grew since the comparison leaves its answer standing until the next one replaces it.
    const stored = state.comparisons.get(`${set.repo}\n${set.key}`);
    const cmp = stored?.hash === set.hash ? stored : currentComparison(state, set);
    const best = cmp?.source === "model" ? bestOf(cmp) : null;
    for (const m of set.members) {
      if (m.state !== "OPEN") continue;
      let of = set.members.filter((x) => x !== m && !ruledOn(m, x));
      if (best) {
        const mine = best(m.number);
        of = mine === m.number ? of.filter((x) => x.started && best(x.number) === mine) : of.filter((x) => x.number === mine);
      } else if (cmp && of.some((x) => x.number === cmp.kept)) of = of.filter((x) => x.number === cmp.kept);
      if (of.length) out.set(`${set.repo}#${m.number}`, { of: of.map((x) => x.number).sort((a, b) => a - b), compared: cmp !== null });
    }
  }
  return out;
}
