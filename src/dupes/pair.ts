// Pair input and reply handling for the duplicate checks. Pure: no I/O, no Node
// imports, because the prompt registry (shared with the web mockup) imports it.
import { wholeReplyJson } from "../core/reply-json.ts";

export const PAIR_BODY_LIMIT = 2000;
/** Jev's yes-probability at or above this makes a pair a duplicate; at or below 1 minus this, distinct. */
export const JEV_ACCEPT = 0.9;
export const JEV_REJECT = 0.1;
/** Jev's yes-probability a Haiku "duplicate" still needs, so the models do not contradict each other outright. */
export const JEV_FLOOR = 0.5;


export const VERDICTS = ["duplicate", "distinct", "unsure"] as const;
export type PairVerdict = (typeof VERDICTS)[number];

export type PairItem = { number: number; kind: "pr" | "issue"; state: string; title: string; body: string };
/** `ref` identifies the pair in replies: `repo#a~b` with a < b. */
export type DupePair = { ref: string; repo: string; a: PairItem; b: PairItem };

const itemView = (i: PairItem) => ({ ref: `#${i.number}`, kind: i.kind === "pr" ? "pull request" : "issue", state: i.state.toLowerCase(), title: i.title, body: (i.body ?? "").slice(0, PAIR_BODY_LIMIT) });

/** What the models see of a pair. */
export const pairView = (p: DupePair): Record<string, unknown> => ({ ref: p.ref, first: itemView(p.a), second: itemView(p.b) });

/** Most candidates one Jev request carries; a longer list is split over several requests. */
export const MAX_ASK_CANDIDATES = 5;

/** One Jev request: an item and the items its pairs name as candidates. Each answer belongs to the pair `ref`. */
export type DupeAsk = { ref: string; repo: string; item: PairItem; candidates: { ref: string; other: PairItem }[] };

/** The name of a candidate's question in the request and its answer. */
export const askKey = (c: { other: PairItem }): string => `same_${c.other.number}`;

/** What Jev sees of a request: the item and its candidates. */
export const askView = (a: DupeAsk): Record<string, unknown> => ({ ...itemView(a.item), candidates: a.candidates.map((c) => itemView(c.other)) });

/**
 * Groups pairs into requests, one item each: the item in the most unasked pairs takes up to MAX_ASK_CANDIDATES of them, and so on
 * until every pair is in one request. Items are told apart by repo and number, so a request's candidates all share its repo and
 * their numbers name them. The pairs keep their order within a request.
 */
export function groupPairs(pairs: readonly DupePair[]): DupeAsk[] {
  const left = new Set(pairs);
  const out: DupeAsk[] = [];
  const key = (repo: string, i: PairItem) => `${repo}#${i.number}`;
  while (left.size) {
    const count = new Map<string, number>();
    for (const p of left) for (const k of [key(p.repo, p.a), key(p.repo, p.b)]) count.set(k, (count.get(k) ?? 0) + 1);
    const [top] = [...count].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))[0]!;
    const take = [...left].filter((p) => key(p.repo, p.a) === top || key(p.repo, p.b) === top).slice(0, MAX_ASK_CANDIDATES);
    for (const p of take) left.delete(p);
    const first = take[0]!;
    const isTop = (p: DupePair) => key(p.repo, p.a) === top;
    out.push({ ref: top, repo: first.repo, item: isTop(first) ? first.a : first.b,
      candidates: take.map((p) => ({ ref: p.ref, other: isTop(p) ? p.b : p.a })) });
  }
  return out;
}

export const pairRef = (repo: string, a: number, b: number): string => `${repo}#${Math.min(a, b)}~${Math.max(a, b)}`;

export type PairAnswer = { ref: string; verdict: PairVerdict; reason: string };

/** Keeps one answer per asked ref with a known verdict. */
export function parsePairReply(text: string, refs: string[]): { answers: PairAnswer[]; missing: string[] } {
  const arr = wholeReplyJson(text);
  const answers: PairAnswer[] = [];
  const seen = new Set<string>();
  if (Array.isArray(arr)) {
    for (const o of arr as Record<string, unknown>[]) {
      if (!o || typeof o !== "object") continue;
      const ref = String(o.ref ?? "");
      if (!refs.includes(ref) || seen.has(ref) || !(VERDICTS as readonly unknown[]).includes(o.verdict)) continue;
      seen.add(ref);
      answers.push({ ref, verdict: o.verdict as PairVerdict, reason: String(o.reason ?? "").slice(0, 200) });
    }
  }
  return { answers, missing: refs.filter((r) => !seen.has(r)) };
}

/** The pair's verdict from Jev's probability and, when Jev is not sure either way, Haiku's answer. With Jev unavailable, Haiku's answer alone. null: Haiku is needed and has not answered. */
export function settlePair(jev: number | null, haiku: PairVerdict | null, jevUnavailable = false): PairVerdict | null {
  if (jevUnavailable) return haiku;
  if (jev !== null && jev >= JEV_ACCEPT) return "duplicate";
  if (jev !== null && jev <= JEV_REJECT) return "distinct";
  if (haiku === null) return null;
  if (haiku === "duplicate") return jev !== null && jev >= JEV_FLOOR ? "duplicate" : "unsure";
  return haiku;
}
