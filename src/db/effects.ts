// External effects (GitHub calls, model calls, build launches, child processes, HTTP) as the database sees them: each is
// counted in the current `db.meter`, and one made inside a database transaction or a `together` wave is refused in tests
// and counted in production, since a transaction holds its locks (and on Postgres a snapshot) while the effect waits on
// the network, and a wave's callers expect database time only.
import { busyScopes, callSite, siteError, testing } from "./handle.ts";

export type EffectKind = "github-write" | "github-read" | "model-call" | "build-launch" | "process" | "http";

/** How often one site's effect inside a transaction or wave is logged again. */
const LOG_EVERY_MS = 60 * 60 * 1000;
/** Most sites kept: they are code locations, so a few dozen at most. */
const MAX_SITES = 200;

export interface EffectInTx {
  readonly site: string;
  readonly kind: EffectKind;
  readonly count: number;
  readonly lastAt: number;
}

let inTxCount = 0;
const inTxSites = new Map<string, { kind: EffectKind; count: number; lastAt: number; loggedAt: number }>();

/**
 * Tells the database layer that the caller is about to make an external effect. Call it before the effect's first await,
 * in the wrapper that makes it. It counts the effect in the meters of the current async context, on every handle (a child
 * process is local work and not counted). Inside a transaction or a `together` wave it throws in tests; in production it
 * counts the call site (`effectsInTx`) and logs it, once per site per hour.
 */
export function effect(kind: EffectKind, site?: string): void {
  const scope = busyScopes(kind !== "process");
  if (scope) note(kind, scope, site ?? callSite(siteError()), testing());
}

/** What `effect` does inside `scope`; `strict` is whether it throws. */
export function note(kind: EffectKind, scope: string, where: string, strict: boolean): void {
  const what = `effect "${kind}" inside ${scope} (${where})`;
  if (strict) throw new Error(`db: ${what}: make it before or after, with a guard read and a write of its own`);
  const now = Date.now();
  inTxCount++;
  let s = inTxSites.get(where);
  if (!s && inTxSites.size < MAX_SITES) inTxSites.set(where, (s = { kind, count: 0, lastAt: now, loggedAt: 0 }));
  if (!s) return;
  s.count++;
  s.lastAt = now;
  if (now - s.loggedAt < LOG_EVERY_MS) return;
  s.loggedAt = now;
  console.warn(`db: ${what}`);
}

/** Effects this process made inside a database transaction or wave: the total and each site, for the health checks. */
export function effectsInTx(): { count: number; sites: EffectInTx[] } {
  return { count: inTxCount, sites: [...inTxSites].map(([site, s]) => ({ site, kind: s.kind, count: s.count, lastAt: s.lastAt })) };
}
