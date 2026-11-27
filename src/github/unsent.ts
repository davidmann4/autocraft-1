// Errors known to be raised before any request went out (no token, no identity, a command that could not start). The error keeps its
// own type, which callers test; a write that fails with one certainly made nothing.
const unsent = new WeakSet<object>();

/** Marks `e` as raised before any request went out; returns it. */
export function markUnsent<T>(e: T): T {
  if (typeof e === "object" && e !== null) unsent.add(e);
  return e;
}

export const isUnsent = (e: unknown): boolean => typeof e === "object" && e !== null && unsent.has(e);

// gh's own wording when GitHub rejects the request before creating anything.
const REFUSED = /issues are disabled|has disabled issues|could not resolve to a repository|not found|forbidden|must have (?:admin|write|push)|permission|requires authentication|bad credentials|gh auth login|HTTP (?:401|403|404|410|422)|validation failed/i;
/** GitHub's rate limits refuse the request before anything is made (`secondary`: the GraphQL client's word for one). */
const RATE_LIMITED = /rate limit|abuse detection|^secondary$/i;

/** Whether the text of a failed write says that GitHub's rate limits refused it: nothing was made, and a later try may go through. */
export const rateLimited = (error: string): boolean => RATE_LIMITED.test(error);
/** Whether the text of a failed write says that GitHub refused it, so nothing was made. */
export const refusedWrite = (error: string): boolean => REFUSED.test(error) || rateLimited(error);

/**
 * Whether an audit row of a write leaves open if it was made: it was never finished, or failed after its request may have gone out
 * (no `sent: false`) without GitHub refusing it.
 */
export function unclearWrite(details: Record<string, unknown> | null): boolean {
  if (details?.state !== "failed") return details?.state === "started";
  return details.sent !== false && !refusedWrite(String(details.error ?? ""));
}
