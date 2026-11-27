// Alert opt-ins and sent alerts (`discord_alerts`, `discord_alert_msgs`). Row identity of a sent alert is (user_hash, workflow_id, rec_at).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { DROP_RETIRED, retiredColumns } from "../../db/retired-names.ts";
import * as kx from "../../db/kx.ts";
// reads: access.discord_links
import { linkedLogin } from "../access/fragments.ts";
import type { Alerter, SentAlert } from "./types.ts";

/** The legacy key of a workflow alert; the column stays filled so rows written here and by older processes share one shape. */
const legacyId = (workflowId: number, recAt: string): string => `wf:${workflowId}:${recAt}`;
const LEGACY = /^wf:([0-9]{1,15}):(.+)$/;

/**
 * Opted-in accounts that still have a link (via the `access.linkedLogin` fragment) and their sent rows after `sinceIso`; 2 statements in the
 * caller's wave. A sent row an older process wrote (no `workflow_id`) is read from its `wf:` key; a row that names no workflow comes back as
 * workflow 0 with an empty `recAt`, so the hourly count still includes it and no workflow matches it.
 */
export async function loadAlertState(db: Db, f: { sinceIso: string }): Promise<{ alerters: Alerter[]; sent: SentAlert[] }> {
  const q = queryDb(db);
  const [alerters, sent] = await db.together(() => Promise.all([
    q.all(q.k.selectFrom("main.discord_alerts as a").select((eb) => ["a.user_hash", "a.sealed", "a.created_at", eb.cast<string | null>(linkedLogin(eb, "a.user_hash"), "text").as("login")])
      .where((eb) => linkedLogin(eb, "a.user_hash"), "is not", null).orderBy("a.user_hash"), { label: "discord.loadAlerters" }),
    q.all(q.k.selectFrom("main.discord_alert_msgs as m").select(["m.user_hash", "m.workflow_id", "m.rec_at", "m.sent_at"]).$if(!DROP_RETIRED, (s) => s.select("m.decision_id"))
      .where("m.sent_at", ">", f.sinceIso)
      .where((eb) => eb("m.user_hash", "in", eb.selectFrom("main.discord_alerts as a").select("a.user_hash").where((e2) => linkedLogin(e2, "a.user_hash"), "is not", null))), { label: "discord.loadSentAlerts" }),
  ]));
  return {
    alerters: alerters.map((r) => ({ userHash: r.user_hash, sealed: r.sealed, createdAt: r.created_at, login: r.login! })),
    sent: sent.map((r) => {
      const legacy = r.workflow_id === null ? LEGACY.exec(r.decision_id ?? "") : null;
      return {
        userHash: r.user_hash, sentAt: r.sent_at,
        workflowId: r.workflow_id !== null ? Number(r.workflow_id) : legacy ? Number(legacy[1]) : 0,
        recAt: r.workflow_id !== null ? (r.rec_at ?? "") : legacy ? legacy[2]! : "",
      };
    }),
  };
}

/** Which user hashes have alerts on. */
export async function loadAlertOptIns(db: Db, userHashes: string[]): Promise<Set<string>> {
  const q = queryDb(db);
  const out = new Set<string>();
  for (const part of kx.chunks([...new Set(userHashes)])) {
    for (const r of await q.all(q.k.selectFrom("main.discord_alerts").select("user_hash").where(kx.inList(db, "user_hash", part)), { label: "discord.loadAlertOptIns" })) out.add(r.user_hash);
  }
  return out;
}

/** Upserts an opt-in; `created_at` is kept on conflict, `sealed` updates. */
export async function saveAlertOptIn(db: Db, row: { userHash: string; sealed: string; createdAt: string }): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.discord_alerts").values({ user_hash: row.userHash, sealed: row.sealed, created_at: row.createdAt })
    .onConflict((oc) => oc.column("user_hash").doUpdateSet(kx.excluded(["sealed"]))));
}

/** Removes opt-ins and their sent rows in one transaction. */
export async function removeAlertOptIns(db: Db, userHashes: string[]): Promise<void> {
  const hashes = [...new Set(userHashes)];
  if (!hashes.length) return;
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.chunks(hashes)) {
      await q.run(q.k.deleteFrom("main.discord_alerts").where(kx.inList(db, "user_hash", part)));
      await q.run(q.k.deleteFrom("main.discord_alert_msgs").where(kx.inList(db, "user_hash", part)));
    }
  });
}

/** Records sent alerts (`ON CONFLICT DO NOTHING`); also marks a closed direct-message channel so it is not retried. */
export async function addSentAlerts(db: Db, rows: SentAlert[]): Promise<void> {
  const q = queryDb(db);
  for (const part of kx.batches(rows)) {
    await q.run(q.k.insertInto("main.discord_alert_msgs").values(part.map((r) => ({
      ...retiredColumns({ decision_id: legacyId(r.workflowId, r.recAt) }), user_hash: r.userHash, sealed: null, sent_at: r.sentAt, workflow_id: r.workflowId, rec_at: r.recAt,
    }))).onConflict((oc) => oc.doNothing()));
  }
}

/** When the newest question a person was shown on each workflow was asked. */
export async function loadShownQuestions(db: Db, userHash: string): Promise<Map<number, string>> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.discord_alert_msgs").select((eb) => ["workflow_id", eb.fn.max<string | null>("rec_at").as("rec_at")])
    .where("user_hash", "=", userHash).where("workflow_id", "is not", null).groupBy("workflow_id"), { label: "discord.loadShownQuestions" });
  return new Map(rows.flatMap((r) => (r.rec_at ? [[Number(r.workflow_id), r.rec_at] as const] : [])));
}

/** The workflows whose questions a person's alerts showed after `since`. */
export async function loadShownSince(db: Db, userHash: string, since: string): Promise<number[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.discord_alert_msgs").select("workflow_id").distinct()
    .where("user_hash", "=", userHash).where("workflow_id", "is not", null).where("sent_at", ">", since), { label: "discord.loadShownSince" });
  return rows.map((r) => Number(r.workflow_id));
}

/** Deletes sent alerts before a time. */
export async function pruneSentAlerts(db: Db, beforeIso: string): Promise<number> {
  const q = queryDb(db);
  return Number((await q.run(q.k.deleteFrom("main.discord_alert_msgs").where("sent_at", "<", beforeIso))).changes);
}
