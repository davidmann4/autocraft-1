// The Opus check of a patch we wrote, before it reaches GitHub (Fix-up pushes, Fix PRs). The model's reply is
// text our code validates; every check is recorded in patch_checks for the Item page.
import { loadPatchChecks, patchHash, recordPatchChecks, type PatchCheckRow } from "../data/changes/index.ts";
import { wholeReplyJson } from "../core/reply-json.ts";
import { CHECK_MAX_PROBLEMS, CHECK_PROBLEM_CHARS, CHECK_REASON_WORDS, type CheckKind, type PatchCheck } from "./types.ts";
import type { Db } from "../db/index.ts";

export { patchHash };

export type { PatchCheckRow };

const words = (s: string, n: number): string => s.replace(/\s+/g, " ").trim().split(" ").slice(0, n).join(" ");

/** The reply's one JSON object (see wholeReplyJson), or why it is not one. */
export function parseCheck(reply: string): { ok: true; check: PatchCheck } | { ok: false; error: string } {
  const o = wholeReplyJson(reply);
  if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: false, error: "the reply is not exactly one JSON object" };
  const v = o as { verdict?: unknown; reasons?: unknown; problems?: unknown };
  if (v.verdict !== "approve" && v.verdict !== "reject") return { ok: false, error: "verdict is not approve or reject" };
  if (typeof v.reasons !== "string") return { ok: false, error: "reasons is not text" };
  const reasons = words(v.reasons, CHECK_REASON_WORDS);
  if (v.verdict === "reject" && !reasons) return { ok: false, error: "a reject gives no reason" };
  const problems = (Array.isArray(v.problems) ? v.problems : []).filter((p): p is string => typeof p === "string" && p.trim() !== "")
    .slice(0, CHECK_MAX_PROBLEMS).map((p) => p.replace(/\s+/g, " ").trim().slice(0, CHECK_PROBLEM_CHARS));
  return { ok: true, check: { verdict: v.verdict, reasons, problems } };
}

/** `subject` is the commit the patch applies to: the PR head (fixup) or the default branch head (fix). */
export async function recordCheck(db: Db, r: { kind: CheckKind; repo: string; number: number; subject: string; patch: string; round: number; model: string; check: PatchCheck; at: string }): Promise<void> {
  await recordPatchChecks(db, [r]);
}

export async function checksOf(db: Db, repo: string, number: number): Promise<PatchCheckRow[]> {
  return (await loadPatchChecks(db, [{ repo, number }])).get(`${repo}#${number}`) ?? [];
}

/** Reasons and problems as one line for a hold note or the next round's prompt. */
export function checkLine(c: PatchCheck): string {
  return [c.reasons, ...c.problems].filter(Boolean).join("; ");
}
