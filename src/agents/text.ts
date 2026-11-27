import { scrub } from "../runner/scrub.ts";

/** One line of error text safe to store and show: credentials hidden. */
export function scrubError(text: string, max = 300): string {
  return scrub(text.replace(/\s+/g, " ").trim()).slice(0, max);
}
