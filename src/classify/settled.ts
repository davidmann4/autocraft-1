// The settled type label of an item for one classification run. Jev judges
// every item; Haiku gives a second opinion on the items Jev is unsure about.
//
// - Jev's top probability >= SURE: Jev's label is settled.
// - Otherwise, Haiku agrees with Jev: settled with that label.
// - Otherwise unsettled: "waiting" while Haiku hasn't answered, "disagree" when
//   it gave another label. A disagreement the Sonnet referee is sure about is
//   settled with its label (source "sonnet"); when it was unsure, the item stays
//   "disagree" with the referee's answer attached, for a person.
// - No Jev verdict in the run (Jev was unavailable): Haiku's label and flags
//   settle the item, source "haiku". Without either verdict: "unclassified".
//
// Each flag (security, needs decision) follows the same rule on its own: Jev
// sure yes sets it, Jev sure no clears it, and between the two bands Haiku's
// flag counts once Haiku has answered (not set before). The type's state does
// not matter for the flags.
//
// settle() is the rule; src/data/triage applies it to the stored verdicts.
import { REFEREE_MAX_FAILURES } from "../core/item-rules.ts";
import { flagBand, JEV_NEEDS_DECISION_YES, JEV_SECURITY_YES } from "./parse.ts";

export const SURE = 0.9;

export type SettledStatus = "settled" | "waiting" | "disagree" | "unclassified";

export type Verdict = { label: string; flags: string[] };

/** The referee's answer to the item's current disagreement. */
export type Referee = {
  label: string; sure: boolean; reason: string;
  /** The answer of the last referee (Opus, after Sonnet was unsure). An unsure final answer still settles the label; its PR stays off the merge rule. */
  final?: boolean;
  /** Opus calls that gave no answer for the item, and when the last one failed. */
  failures?: number;
  failedAt?: string;
};

/** The referee has had its last word: Opus answered, or failed too often. An unsure last word still settles the label. */
export const refereeClosed = (r: Referee | null | undefined): boolean => !!r && (!!r.final || (r.failures ?? 0) >= REFEREE_MAX_FAILURES);

export type Settled = {
  status: SettledStatus;
  label: string | null;          // set only when status is "settled"
  source: "jev" | "haiku" | "sonnet" | null;
  confidence: number | null;     // Jev's top probability
  jevLabel: string | null;
  haikuLabel: string | null;
  // Flags that are set: see the rule above.
  flags: string[];
  // The referee's answer when one exists for the current verdicts, else null.
  referee: Referee | null;
};

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

const parseFlags = (s: string | null): string[] => {
  try {
    const f = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(f) ? f.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
};

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
