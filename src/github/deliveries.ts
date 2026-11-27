// The GitHub App's own record of its webhook deliveries (`GET /app/hook/deliveries`, newest first), read by each sync run. A
// delivery this server did not take (the receiver was restarting, the gateway failed, a timeout) is asked for again, up to
// three attempts in all, so a missed change and a missed command in a comment both arrive late instead of never. Any delivery
// that did not succeed also makes the run poll GitHub (src/mirror.ts pollReason), because what it named is not in the mirror.
//
// Comment commands arrive only by webhook, so a failed delivery the check skips is a command lost for good. The checkpoint
// (sync_state.deliveries_checked_at) therefore moves only up to the oldest failed delivery a check left for later (past the
// per-check cap, or a redelivery request that failed), and the next check reads the list back to it.
import type { AppSecrets } from "../dash/server/config.ts";
import { loadRedeliveries, loadSyncState, noteRedelivery, saveSyncState } from "../data/mirror/index.ts";
import type { Db } from "../db/index.ts";
import { appJwt, callPage, GITHUB_API } from "./app.ts";
import { redeliverWebhook } from "./write.ts";

/** `id` is the exact decimal text: GitHub delivery ids exceed 2^53, which a JS number rounds. */
export type Delivery = { id: string; guid: string; delivered_at: string; status_code: number; event: string };
/** Parses a deliveries list body, keeping each delivery's `id` as its exact source text. */
export function parseDeliveries(text: string): unknown {
  // The lib typings lack the reviver's third argument (Node 24: `context.source`, the number's literal text).
  const reviver = (key: string, value: unknown, context?: { source?: string }): unknown =>
    key === "id" && typeof value === "number" && context?.source ? context.source : value;
  return JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
}
/** One page of the list; `next` is the next page's cursor, null on the last page. */
export type DeliveryPage = { deliveries: Delivery[]; next: string | null };

/** Deliveries newer than this may still be in flight; the next check looks at them. */
const SETTLE_MS = 30_000;
/** How far back the first check looks. */
const FIRST_LOOK_MS = 3600_000;
/** Attempts of one delivery, the first included, after which it is left alone. */
const MAX_ATTEMPTS = 3;
/** Redeliveries one check asks for at most, oldest first; the rest wait for the next check. */
const MAX_REDELIVER = 20;
/** A redelivery GitHub accepted whose new attempt is not in the list by then is given up. */
const ARRIVE_MS = 10 * 60_000;
/** GitHub keeps deliveries three days; the record of a redelivery is kept as long. */
const KEPT_MS = 3 * 86_400_000;
const PAGE = 100;
/** Pages one check reads at most; deliveries older than the last of them are not checked. */
const MAX_PAGES = 50;

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
/** The second before `t`: a checkpoint there keeps a delivery at `t` in the next check's span, which starts after it. */
const before = (t: string): string => iso(Date.parse(t) - 1000);
const ok = (d: Delivery): boolean => d.status_code >= 200 && d.status_code < 300;
/** No answer, a server error or a rate limit: worth sending again. A 4xx is this server refusing it, which a retry repeats. */
const retryable = (d: Delivery): boolean => d.status_code === 0 || d.status_code === 429 || d.status_code >= 500;

export type DeliveryCheck = {
  /** Deliveries in the checked span that never succeeded. */
  failed: number;
  redelivered: number;
  /** False when the pages read did not reach back to the last check: deliveries may have failed unseen. */
  covered: boolean;
};

export type DeliveryDeps = {
  list?: (cursor: string | null) => Promise<DeliveryPage>;
  redeliver?: (d: Delivery) => Promise<void>;
  log?: (line: string) => void;
};

/** Checks the deliveries since the last check and asks for the failed ones again. */
export async function checkDeliveries(db: Db, app: AppSecrets, now = Date.now(), deps: DeliveryDeps = {}): Promise<DeliveryCheck> {
  const log = deps.log ?? console.log;
  const list = deps.list ?? (async (cursor: string | null): Promise<DeliveryPage> => {
    const r = await callPage(GITHUB_API, cursor ?? `/app/hook/deliveries?per_page=${PAGE}`, appJwt(app), parseDeliveries);
    return { deliveries: Array.isArray(r.body) ? (r.body as Delivery[]) : [], next: r.next };
  });
  const redeliver = deps.redeliver ?? ((d: Delivery) => redeliverWebhook({ db, login: "webhook-check" }, { app, id: d.id, guid: d.guid, event: d.event }));
  let since = (await loadSyncState(db)).deliveries_checked_at ?? iso(now - FIRST_LOOK_MS);
  const until = iso(now - SETTLE_MS);

  const seen: Delivery[] = [];
  let covered = false;
  let cursor: string | null = null;
  for (let pages = 0; pages < MAX_PAGES && !covered; pages++) {
    const page = await list(cursor);
    const valid = page.deliveries.filter((d) => typeof d?.guid === "string" && typeof d.delivered_at === "string");
    seen.push(...valid);
    covered = !page.next || valid.some((d) => d.delivered_at <= since);
    cursor = page.next;
  }
  if (!covered && seen.length) {
    const oldest = seen.reduce((a, d) => (d.delivered_at < a ? d.delivered_at : a), seen[0]!.delivered_at);
    log(`webhook deliveries: more than ${MAX_PAGES} pages since ${since}; those before ${oldest} are not checked`);
    if (before(oldest) > since) since = before(oldest);
  }

  const attempts = new Map<string, Delivery[]>();
  for (const d of seen) attempts.set(d.guid, [...(attempts.get(d.guid) ?? []), d]);
  // The deliveries whose latest attempt falls in the span, oldest first: a redelivery shows up again as a new attempt with a later time.
  const failedInSpan = [...attempts.values()]
    .map((all) => all.sort((a, b) => b.delivered_at.localeCompare(a.delivered_at)))
    .filter((all) => all[0]!.delivered_at > since && all[0]!.delivered_at <= until && !all.some(ok))
    .sort((a, b) => a[0]!.delivered_at.localeCompare(b[0]!.delivered_at));
  const asked = await loadRedeliveries(db, failedInSpan.map((all) => all[0]!.guid));

  // Where the next check starts: the end of the span, or just before the oldest delivery this check left for later.
  let checkpoint = until;
  const holdAt = (t: string): void => {
    if (t < checkpoint) checkpoint = t;
  };
  const nowIso = iso(now);
  let failed = 0;
  let redelivered = 0;
  for (const all of failedInSpan) {
    const latest = all[0]!;
    const row = asked.get(latest.guid);
    if (row?.asked_at && row.asked_at > latest.delivered_at) {
      // Asked for again and accepted, the new attempt not listed yet: the next check looks for it, for a while.
      if (Date.parse(row.asked_at) > now - ARRIVE_MS) holdAt(before(row.asked_at));
      else log(`webhook delivery ${latest.guid} (${latest.event}): its redelivery never showed up; not sent again`);
      continue;
    }
    failed++;
    const tries = Math.max(all.length, 1 + (row?.asked ?? 0));
    if (!retryable(latest) || tries >= MAX_ATTEMPTS) {
      log(`webhook delivery ${latest.guid} (${latest.event}) failed with ${latest.status_code || "no answer"}; not sent again`);
      continue;
    }
    if (redelivered >= MAX_REDELIVER) {
      holdAt(before(latest.delivered_at));
      continue;
    }
    let accepted = false;
    try {
      await redeliver(latest);
      accepted = true;
      redelivered++;
    } catch (e) {
      log(`webhook redelivery ${latest.guid}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      holdAt(before(latest.delivered_at));
    }
    await noteRedelivery(db, latest.guid, accepted, nowIso, iso(now - KEPT_MS));
  }
  await saveSyncState(db, { deliveries_checked_at: checkpoint > since ? checkpoint : since });
  if (failed) log(`webhook deliveries: ${failed} failed, ${redelivered} asked for again`);
  return { failed, redelivered, covered };
}
