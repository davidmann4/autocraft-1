// Short model-written texts (summaries, one-sentence reasons). No I/O and no Node
// imports: the prompt registry imports it. Code never cuts such a text mid-sentence:
// an over-long one is a reply-lint problem (src/replylint.ts) that goes back to the model once,
// and what is still too long is stored as its first sentence.

/** Words a summary may have; the prompts ask for about 60. */
export const SUMMARY_MAX_WORDS = 80;
/** Words of the one-sentence reason behind a recommendation. */
export const WHY_MAX_WORDS = 30;

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
export const wordCount = (s: string): number => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** The text up to and including its first sentence end; the whole text when it has none. */
export function firstSentence(s: string): string {
  const t = squash(s);
  return /^.*?[.!?](?=\s|$)/.exec(t)?.[0] ?? t;
}

/** The text with its end mark, a full stop when it has none. */
export const asSentence = (s: string): string => (/[.!?…]$/.test(s) ? s : `${s}.`);

/** The text when it fits in `max` characters, else its start up to a word end with "…". Text without spaces is cut where it stops fitting. */
export function clipText(s: string, max: number): string {
  const t = squash(s);
  if (t.length <= max) return t;
  const head = t.slice(0, max - 2);
  // A word is whole when the next character is a space.
  const end = t[max - 2] === " " ? head.length : head.lastIndexOf(" ");
  const words = (end > max / 2 ? head.slice(0, end) : head).replace(/[\s,;:(–-]+$/, "");
  return /[.!?]$/.test(words) ? `${words} …` : `${words}…`;
}

/**
 * Reads an optional prose field of a reply. Missing or empty: null, valid. Within `max` words: the text.
 * Over `max`: invalid unless `last` (the final attempt), then its first sentence.
 */
export function proseField(v: unknown, max: number, last: boolean): { ok: true; text: string | null } | { ok: false } {
  if (typeof v !== "string" || !squash(v)) return { ok: true, text: null };
  const t = squash(v);
  if (wordCount(t) <= max) return { ok: true, text: t };
  return last ? { ok: true, text: firstSentence(t) } : { ok: false };
}

/** A one-sentence field (why): its first sentence when it has more than one, else the text unchanged; null stays null. */
export const oneSentence = (s: string | null): string | null => (s === null ? null : firstSentence(s));
