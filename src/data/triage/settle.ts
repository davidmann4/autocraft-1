// The settle rule and the pure helpers around it, moved from classify/settled.ts and labels/settled.ts. No queries.
//
// - Jev's top probability >= SURE: Jev's label is settled.
// - Otherwise, Haiku agrees with Jev: settled with that label.
// - Otherwise unsettled: "waiting" while Haiku hasn't answered, "disagree" when it gave another label. A disagreement the Sonnet
//   referee is sure about is settled with its label (source "sonnet"); when it was unsure, the item stays "disagree" with the
//   referee's answer attached, for a person.
// - No Jev verdict in the run (Jev was unavailable): Haiku's label and flags settle the item, source "haiku". Without either
//   verdict: "unclassified".
//
// Each flag (security, needs decision) follows the same rule on its own: Jev sure yes sets it, Jev sure no clears it, and between
// the two bands Haiku's flag counts once Haiku has answered (not set before). The type's state does not matter for the flags.
import type { ClsRow, Referee, Settled, SettledStatus } from "./types.ts";

/** Jev's flag bands: yes from the flag's own threshold, no below JEV_FLAG_NO, unsure in between (Haiku decides). */
export const JEV_SECURITY_YES = 0.9;
export const JEV_NEEDS_DECISION_YES = 0.8;
export const JEV_FLAG_NO = 0.3;
export type FlagBand = "yes" | "no" | "unsure";
export const flagBand = (p: number, yesMin: number): FlagBand => (p >= yesMin ? "yes" : p < JEV_FLAG_NO ? "no" : "unsure");

/** Opus answers the label referee may fail to give for an item before its turn ends. */
export const REFEREE_MAX_FAILURES = 3;

export const SURE = 0.9;

export type Verdict = { label: string; flags: string[] };

/** The referee has had its last word: Opus answered, or failed too often. An unsure last word still settles the label. */
export const refereeClosed = (r: Referee | null | undefined): boolean => !!r && (!!r.final || (r.failures ?? 0) >= REFEREE_MAX_FAILURES);

/** Jev's needs_decision probability a settled bugfix needs before its "needs decision" flag counts. */
export const BUGFIX_NEEDS_DECISION = 0.7;

/** Jev raises needs_decision too freely on plain bugs: on a settled bugfix the flag counts only when Jev is firm. */
function firmFlags(s: Settled, nd: number | null | undefined): Settled {
  if (s.label !== "bugfix" || !s.flags.includes("needs decision") || (nd ?? 0) >= BUGFIX_NEEDS_DECISION) return s;
  return { ...s, flags: s.flags.filter((f) => f !== "needs decision") };
}

type JevVerdict = Verdict & { top: number | null; nd?: number | null; sec?: number | null };

/** One flag: Jev's band decides; unsure takes Haiku's answer, if any. A missing probability falls back to Jev's stored flag. */
function flagSet(name: string, p: number | null | undefined, yesMin: number, jev: JevVerdict, haiku: Verdict | null): boolean {
  if (typeof p !== "number") return jev.flags.includes(name);
  const band = flagBand(p, yesMin);
  return band === "unsure" ? !!haiku?.flags.includes(name) : band === "yes";
}

/** `jev.nd` and `jev.sec` are Jev's needs_decision and security probabilities (needsDecisionOf, securityOf). */
export function settle(jev: JevVerdict | null, haiku: Verdict | null, referee: Referee | null = null): Settled {
  const s = settleLabel(jev, haiku, referee);
  if (!jev) return s;
  const flags = [
    ...(flagSet("security", jev.sec, JEV_SECURITY_YES, jev, haiku) ? ["security"] : []),
    ...(flagSet("needs decision", jev.nd, JEV_NEEDS_DECISION_YES, jev, haiku) ? ["needs decision"] : []),
  ];
  const firm = firmFlags({ ...s, flags }, jev.nd);
  // The last referee was unsure whether we have the feature or want the difference: the label stands and a maintainer makes the call.
  return refereeClosed(referee) && !referee!.sure && !firm.flags.includes("needs decision") ? { ...firm, flags: [...firm.flags, "needs decision"] } : firm;
}

function settleLabel(jev: (Verdict & { top: number | null }) | null, haiku: Verdict | null, referee: Referee | null): Settled {
  if (!jev && haiku) return { status: "settled", label: haiku.label, source: "haiku", confidence: null, jevLabel: null, haikuLabel: haiku.label, flags: haiku.flags, referee: null };
  if (!jev) return { status: "unclassified", label: null, source: null, confidence: null, jevLabel: null, haikuLabel: null, flags: [], referee: null };
  const base = { confidence: jev.top, jevLabel: jev.label, haikuLabel: haiku?.label ?? null, referee: null };
  const flags: string[] = [];
  if ((jev.top ?? 0) >= SURE) return { ...base, status: "settled", label: jev.label, source: "jev", flags };
  if (!haiku) return { ...base, status: "waiting", label: null, source: null, flags };
  if (haiku.label === jev.label) return { ...base, status: "settled", label: jev.label, source: "haiku", flags };
  if (referee?.sure || refereeClosed(referee)) return { ...base, referee, status: "settled", label: referee!.label, source: "sonnet", flags };
  return { ...base, referee, status: "disagree", label: null, source: null, flags };
}

export const parseFlags = (s: string | null): string[] => {
  try {
    const f = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(f) ? f.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
};

/** A pipeline referee row: evaluation rows have no `sure` in probs and give null. */
function refereeOf(label: string, probs: string | null, reason: string | null): Referee | null {
  try {
    const p = JSON.parse(probs ?? "null") as { sure?: unknown; final?: unknown; opusFailures?: unknown; opusFailedAt?: unknown } | null;
    return typeof p?.sure === "boolean" ? { label, sure: p.sure, reason: reason ?? "", ...(p.final === true && { final: true }), ...(typeof p.opusFailures === "number" && { failures: p.opusFailures }), ...(typeof p.opusFailedAt === "string" && { failedAt: p.opusFailedAt }) } : null;
  } catch { return null; }
}

export function needsDecisionOf(probs: string | null): number | null {
  try {
    const t = (JSON.parse(probs ?? "null") as { needs_decision?: unknown } | null)?.needs_decision;
    return typeof t === "number" ? t : null;
  } catch { return null; }
}

export function securityOf(probs: string | null): number | null {
  try {
    const t = (JSON.parse(probs ?? "null") as { security?: unknown } | null)?.security;
    return typeof t === "number" ? t : null;
  } catch { return null; }
}

export function topOf(probs: string | null): number | null {
  try {
    const t = (JSON.parse(probs ?? "null") as { top?: unknown } | null)?.top;
    return typeof t === "number" ? t : null;
  } catch { return null; }
}


/** An item without a Jev or Haiku verdict. */
export const UNCLASSIFIED: Settled = settle(null, null);

/** The settled label from an item's verdict rows of one run: Jev's and Haiku's, and the referee's when both count. */
export function settledOfRows(rows: readonly ClsRow[]): Settled {
  const by: Partial<Record<string, ClsRow>> = {};
  for (const r of rows) by[r.classifier] = r;
  const j = by.jev;
  // A Haiku row without a Jev row counts only when Haiku classified alone.
  const h = by.haiku && (j || by.haiku.input_hash !== null) ? by.haiku : undefined;
  const r = j && h ? by.sonnet : undefined;
  return settle(
    j && j.type_label !== null ? { label: j.type_label, flags: parseFlags(j.flags), top: topOf(j.probs), nd: needsDecisionOf(j.probs), sec: securityOf(j.probs) } : null,
    h && h.type_label !== null ? { label: h.type_label, flags: parseFlags(h.flags) } : null,
    r && r.type_label !== null && j && h && r.at >= j.at && r.at >= h.at ? refereeOf(r.type_label, r.probs, r.reason) : null,
  );
}

export type SettledRow = {
  status: string | null; label: string | null; source: string | null;
  top: number | null; jev_label: string | null; haiku_label: string | null; flags: string | null;
  referee_label: string | null; referee_sure: number | null; referee_reason: string | null; referee_final?: number | null;
};

// An item_settled row (or none) as the wire shape.
export function fromRow(r: Partial<SettledRow> | undefined): Settled {
  if (!r?.status) return settle(null, null);
  return {
    status: r.status as SettledStatus, label: r.label ?? null, source: (r.source as Settled["source"]) ?? null,
    confidence: r.top ?? null, jevLabel: r.jev_label ?? null, haikuLabel: r.haiku_label ?? null, flags: parseFlags(r.flags ?? null),
    referee: r.referee_label != null && r.referee_sure != null ? { label: r.referee_label, sure: !!r.referee_sure, reason: r.referee_reason ?? "", ...(r.referee_final ? { final: true } : {}) } : null,
  };
}

/** The verdict of a quiet pull request without its `security` flag (for every role), and without the referee's reason for viewers. */
export const unflagged = (s: Settled, quiet: boolean, staff = true): Settled =>
  quiet ? { ...s, flags: s.flags.filter((f) => f !== "security"), referee: s.referee && !staff ? { ...s.referee, reason: "" } : s.referee } : s;

// The labels stage's view: one item's rows of one run, settled by the same rule without the referee.
export type LabelSettled = { type: string; security: boolean; needsDecision: boolean };
export type LabelRow = { classifier: string; run_id: string; at: string; type_label: string | null; flags: string | null; probs: string | null; input_hash?: string | null };

// rows: the classifications of one item in one run.
export function settleRows(rows: LabelRow[]): LabelSettled | null {
  const jev = rows.find((r) => r.classifier === "jev");
  // A Haiku row without a Jev row counts only when Haiku classified alone (it carries the item's input hash).
  const haiku = rows.find((r) => r.classifier === "haiku" && (jev || r.input_hash != null));
  if (!jev?.type_label && !haiku?.type_label) return null;
  const s = settle(
    jev?.type_label ? { label: jev.type_label, flags: parseFlags(jev.flags), top: topOf(jev.probs), nd: needsDecisionOf(jev.probs), sec: securityOf(jev.probs) } : null,
    haiku?.type_label ? { label: haiku.type_label, flags: parseFlags(haiku.flags) } : null,
  );
  if (s.status !== "settled" || s.label === null) return null;
  return { type: s.label, security: s.flags.includes("security"), needsDecision: s.flags.includes("needs decision") };
}

export function forRun(rows: LabelRow[], runId?: string): LabelRow[] {
  const id = runId ?? rows.find((r) => r.classifier === "jev" || (r.classifier === "haiku" && r.input_hash != null))?.run_id;
  return id === undefined ? [] : rows.filter((r) => r.run_id === id);
}
