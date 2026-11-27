// The short version of an item's result that is too long for one Discord message (src/discord/results.ts): Haiku shortens the
// numbered parts of the review; AutoCraft keeps the recommendation line word for word and adds the link to GitHub. Pure; no Node
// imports (the Prompts page imports it).
import { wholeReplyJson } from "../core/reply-json.ts";

export const RESULT_PARTS_MAX = 40;
export const RESULT_TITLE_CHARS = 400;
/** Lines of the summary, and characters per line. */
export const RESULT_SUMMARY_LINES = 6;
export const RESULT_LINE_CHARS = 160;

export type ResultPart = { n: number; title: string; state: "planned" | "dropped" | "fixed"; major?: boolean };
/** `recommendation` is given as context only; the model does not write it. */
export type ResultAsk = { ref: string; recommendation: string | null; parts: ResultPart[] };
/** One summary line: the part numbers it covers and its text. */
export type ResultLine = { parts: number[]; text: string };

export const SAMPLE_RESULT: ResultAsk[] = [{
  ref: "photocraft#7",
  recommendation: "Recommendation: Fix 1 and 2, then merge. Reply yes to fix 1 and 2, then merge (after the pre-merge check and green CI).",
  parts: [
    { n: 1, title: "src/export/webp.rs:88 passes the quality setting as a fraction while the encoder expects 0 to 100, so every export uses the lowest quality.", state: "planned", major: true },
    { n: 2, title: "src/export/webp.rs:120 ignores the error of the encoder and writes an empty file.", state: "planned" },
    { n: 3, title: "The new test covers only the default quality.", state: "dropped" },
  ],
}];

const clean = (a: ResultAsk): ResultAsk => ({
  ref: a.ref, recommendation: a.recommendation,
  parts: a.parts.slice(0, RESULT_PARTS_MAX).map((p) => ({ n: p.n, title: p.title.slice(0, RESULT_TITLE_CHARS), state: p.state, ...(p.major ? { major: true } : {}) })),
});

/** The data of one call, as one JSON string: the prompt's data block. */
export const resultState = (a: ResultAsk): string => JSON.stringify(clean(a), null, 1).replace(/</g, "\\u003c");

/** Haiku's reply: `{"lines": [{"parts": [n, ...], "text": "..."}]}`; lines naming no part of the ask are left out. null when no line is left. */
export function parseResult(text: string, a: ResultAsk): ResultLine[] | null {
  const v = (wholeReplyJson(text) as { lines?: unknown } | null)?.lines;
  if (!Array.isArray(v)) return null;
  const known = new Set(a.parts.map((p) => p.n));
  const out: ResultLine[] = [];
  for (const l of v) {
    const parts = Array.isArray((l as { parts?: unknown })?.parts) ? ((l as { parts: unknown[] }).parts.filter((n): n is number => typeof n === "number" && known.has(n))) : [];
    const t = (l as { text?: unknown })?.text;
    if (!parts.length || typeof t !== "string" || !t.trim()) continue;
    out.push({ parts: [...new Set(parts)], text: t.replace(/\s+/g, " ").trim().slice(0, RESULT_LINE_CHARS) });
    if (out.length >= RESULT_SUMMARY_LINES) break;
  }
  return out.length ? out : null;
}
