// Writers (M15 intake part).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import type { Ref } from "../keys.ts";
import { loadOverrides, loadOwnLogins } from "../access/index.ts";
import { addAudit, loadTrip, saveSettings, tripStage } from "../control/index.ts";
import { loadAuthorHistory, loadAuthorIds } from "../mirror/index.ts";
import { reviewBots } from "../../review/bots.ts";
import { loadCandidates } from "./candidates.ts";
import { DAY_MS } from "./constants.ts";
import { KEY_OF, limitsOf, ruleOf } from "./limits.ts";
import { authorKey } from "./constants.ts";
import { computeHolds, holdAuthors, parseOutsideLimits } from "./pure.ts";
import { OUTSIDE_SURGE, OutsideError, type Hold, type HoldInput, type OutsideLimits, type WhitelistPolicy } from "./types.ts";

/**
 * Recomputes the holds from the items created in the last 24 hours (and, while the surge breaker is tripped, from an hour before
 * its trip), evaluates the surge breaker and writes `outside_holds` as a difference. Reads: 1 wave (the candidates, the current
 * holds, the breaker) plus 1 more when an author's whitelist standing is needed; write: one transaction (trip, admissions, holds).
 * `whitelist` is the pure policy of `src/whitelist.ts`. Never calls GitHub or a model.
 */
export async function recomputeHolds(db: Db, opts: { now?: number; whitelist: WhitelistPolicy; /** Our logins, when the caller read them. */ own?: ReadonlySet<string> }): Promise<{ holds: Hold[]; tripped: boolean; wakeAt: number | null }> {
  const now = opts.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const q = queryDb(db);
  const limits = await limitsOf(db);
  const on = limits.prsPerDay > 0 || limits.issuesPerDay > 0 || limits.surgePerHour > 0;
  const own = on ? [...opts.own ?? await loadOwnLogins(db)].map((l) => l.toLowerCase()) : [];
  const [rows, have, trip] = await db.together(() => Promise.all([
    on ? loadCandidates(db, { dayAgo: new Date(now - DAY_MS).toISOString(), surge: limits.surgePerHour > 0, own, bots: reviewBots() }) : Promise.resolve([]),
    q.all(q.k.selectFrom("main.outside_holds").select(["repo", "number", "author", "kind", "reason"]).$narrowType<{ kind: Hold["kind"]; reason: Hold["reason"] }>()),
    loadTrip(db, OUTSIDE_SURGE),
  ]));
  const input: HoldInput = { rows, limits, nowMs: now, trip: trip ? { active: trip.active, trippedAt: trip.trippedAt, clearedAt: trip.clearedAt } : null, whitelisted: new Set() };
  const authors = holdAuthors(input);
  if (authors.length) {
    const logins = [...new Set(authors.map((a) => a.login))];
    const [overrides, history, bound, rule] = await db.together(() => Promise.all([loadOverrides(db, logins), loadAuthorHistory(db, { logins }), loadAuthorIds(db, logins), ruleOf(db)]));
    const verdicts = opts.whitelist({ authors, overrides, history, bound, rule });
    input.whitelisted = new Set(authors.filter((a) => verdicts.get(`${a.login}\0${a.id ?? ""}`)).map((a) => authorKey(a.login, a.id)));
  }
  const res = computeHolds(input);
  const key = (h: { repo: string; number: number }) => `${h.repo}#${h.number}`;
  const had = new Map(have.map((h) => [key(h), h]));
  const wanted = new Map(res.holds.map((h) => [key(h), h]));
  const gone = have.filter((h) => !wanted.has(key(h))).map((h): [string, number] => [h.repo, h.number]);
  const changed = res.holds.filter((h) => { const o = had.get(key(h)); return !o || o.author !== h.author || o.kind !== h.kind || o.reason !== h.reason; });
  if (res.tripSurge || res.admissions.length || gone.length || changed.length) {
    await db.write(async () => {
      if (res.tripSurge) await tripStage(db, [{ key: OUTSIDE_SURGE, reason: res.tripSurge.reason, evidence: res.tripSurge.evidence, at: nowIso }]);
      for (const part of kx.batches(res.admissions.map((a) => ({ ...a, at: nowIso }))))
        await q.run(q.k.insertInto("main.outside_admitted").values(part).onConflict((oc) => oc.doNothing()));
      for (const part of kx.chunks(gone)) await q.run(q.k.deleteFrom("main.outside_holds").where(kx.refIn(db, "outside_holds", part)));
      for (const part of kx.batches(changed.map((h) => ({ repo: h.repo, number: h.number, author: h.author, kind: h.kind, reason: h.reason }))))
        await q.run(q.k.insertInto("main.outside_holds").values(part).onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(kx.excluded(["author", "kind", "reason"]))));
    });
  }
  return { holds: res.holds, tripped: !!res.tripSurge || !!trip?.active, wakeAt: res.wakeAt };
}

/** Moves the held refs to `outside_released` and audits one row per item; throws 409 when `refs` is non-empty and none was held. Returns how many. */
export async function releaseHeld(db: Db, by: string, refs: Ref[]): Promise<number> {
  if (refs.length === 0) return 0;
  const q = queryDb(db);
  return await db.write(async () => {
    const rows = await q.all(q.k.deleteFrom("main.outside_holds").where(kx.refIn(db, "outside_holds", refs.map((r): [string, number] => [r.repo, r.number]))).returning(["repo", "number", "author"]));
    if (rows.length === 0) throw new OutsideError(refs.length === 1 ? `${refs[0]!.repo}#${refs[0]!.number} is not held for its author` : `none of the ${refs.length} items is held for its author`, 409);
    await settle(db, by, rows.map((r) => ({ repo: r.repo, number: r.number })), rows.map((r) => ({ login: by, action: "outside-release", target: `${r.repo}#${r.number}`, details: { author: r.author } })));
    return rows.length;
  });
}

/** The same keyed by author (without case); throws 409 when nothing is held. Returns how many. */
export async function releaseAuthor(db: Db, by: string, author: string): Promise<number> {
  const q = queryDb(db);
  return await db.write(async () => {
    const rows = await q.all(q.k.deleteFrom("main.outside_holds").where((eb) => kx.ciEq(db, "author", eb.val(author))).returning(["repo", "number"]));
    if (rows.length === 0) throw new OutsideError(`nothing is held for ${author}`, 409);
    await settle(db, by, rows, [{ login: by, action: "outside-release-author", target: author, details: { items: rows.length } }]);
    return rows.length;
  });
}

async function settle(db: Db, by: string, rows: { repo: string; number: number }[], audit: Parameters<typeof addAudit>[1]): Promise<void> {
  const q = queryDb(db);
  const at = new Date().toISOString();
  for (const part of kx.batches(rows.map((r) => ({ repo: r.repo, number: r.number, by, at }))))
    await q.run(q.k.insertInto("main.outside_released").values(part).onConflict((oc) => oc.doNothing()));
  await addAudit(db, audit);
}

/** Stores the three numbers (0 turns a protection off) and audits the change with the `abuse-limits` action; nothing is written when none changed. */
export async function saveOutsideLimits(db: Db, by: string, input: unknown): Promise<OutsideLimits> {
  const was = await limitsOf(db);
  const next = parseOutsideLimits(input, was);
  if (JSON.stringify(was) === JSON.stringify(next)) return next;
  await saveSettings(db, (Object.keys(KEY_OF) as (keyof OutsideLimits)[]).map((k) => ({ key: KEY_OF[k], value: String(next[k]) })), by, { action: "abuse-limits", target: "pipeline", details: { ...next, was } });
  return next;
}
