// The audit table: writers, the GitHub write log and typed readers (M06 control-b).
import type { Expression, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { GITHUB_ACTIONS } from "../../github/actions.ts";
import { unclearWrite } from "../../github/unsent.ts";
import type { AuditFilter, AuditPageFilter, AuditRow, AuditWhere, Details, NewAudit, PaceKey, WriteLogRow, WritePace } from "./types.ts";

const AUDIT = "main.audit";

/** The pacing budget of GitHub writes per identity and owner key (a user token is limited per account). */
const PACE_PER_MINUTE = 60;
const PACE_PER_HOUR = 400;
/** Bulk actions (labels, status comments) may use this share of the budget. */
const BULK_SHARE = 0.5;
const BULK_ACTIONS = new Set(["labels-apply", "pr-status-comment", "pr-status-comment-edit"]);
const SECONDARY_PAUSE_MS = 60_000;
const SECONDARY_LIMIT = /secondary rate limit|abuse/i;
const PACE_WINDOW_MS = 3_600_000;

/** `details` as an object; null when absent, not JSON, or not an object. */
function parseDetails(text: string | null | undefined): Details | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Details) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

type RawAudit = { rowid: number | string; at: string; login: string; action: string; target: string | null; details: string | null };
const toRow = (r: RawAudit): AuditRow => ({ rowid: Number(r.rowid), at: r.at, login: r.login, action: r.action, target: r.target, details: parseDetails(r.details) });

/** `details` when it is valid JSON, else NULL: the JSON field readers need valid text on Postgres. */
const valid = (db: Db, eb: kx.AnyEb): Expression<string | null> => eb.case().when(kx.jsonValid(db, "details")).then(eb.ref("details")).end() as Expression<string | null>;

/** The conditions of a closed set of JSON detail fields. */
function whereOf(db: Db, eb: kx.AnyEb, w: AuditWhere | undefined): Expression<SqlBool>[] {
  if (!w) return [];
  const d = valid(db, eb);
  const c: Expression<SqlBool>[] = [];
  if (w.state !== undefined) c.push(eb(kx.jsonText(db, d, "$.state"), "=", w.state));
  if (w.source !== undefined) c.push(eb(kx.jsonText(db, d, "$.source"), "=", w.source));
  if (w.card !== undefined) c.push(eb(kx.jsonNum(db, d, "$.card"), "=", w.card));
  if (w.held !== undefined) c.push(eb(kx.jsonNum(db, d, "$.held"), "=", w.held));
  if (w.commit !== undefined) c.push(eb(kx.jsonText(db, d, "$.commit"), "=", w.commit));
  return c;
}

// ---- writers ---------------------------------------------------------------------------------------------------------

/**
 * Batched insert chunked at `BATCH_ROWS`; an empty array does nothing. Rows without `at` share one time; rowids follow the
 * array order. Inside the caller's transaction the rows commit with the change; several chunks outside one run in a
 * transaction of their own.
 */
export async function addAudit(db: Db, rows: NewAudit[]): Promise<void> {
  if (!rows.length) return;
  const q = queryDb(db);
  const now = new Date().toISOString();
  const values = rows.map((r) => ({ at: r.at ?? now, login: r.login, action: r.action, target: r.target ?? null, details: r.details === undefined ? null : JSON.stringify(r.details) }));
  const parts = kx.batches(values);
  const insert = async (): Promise<void> => { for (const part of parts) await q.run(q.k.insertInto(AUDIT).values(part)); };
  if (parts.length > 1 && !db.inTransaction()) await db.write(insert);
  else await insert();
}

/** At most one row per login per hour; later refusals raise `details.refused`. */
export async function recordRefusedSignIn(db: Db, login: string, details: Details): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const last = await q.get(q.k.selectFrom(AUDIT).select([kx.rowid(AUDIT).as("rowid"), "details"])
      .where("action", "=", "sign-in-refused").where("login", "=", login).where("at", ">", since).orderBy("at", "desc").limit(1));
    if (!last) return await addAudit(db, [{ login, action: "sign-in-refused", target: login, details: { ...details, refused: 1 } }]);
    const prev = parseDetails(last.details) ?? {};
    const refused = (typeof prev.refused === "number" ? prev.refused : 1) + 1;
    await q.run(q.k.updateTable(AUDIT).set({ details: JSON.stringify({ ...prev, refused }) }).where(kx.rowid(AUDIT), "=", Number(last.rowid)));
  });
}

/** The `deadline-ack` rows (`target = step:<step>`). */
export async function ackDeadlines(db: Db, steps: string[], by: string): Promise<void> {
  await addAudit(db, steps.map((s) => ({ login: by, action: "deadline-ack", target: `step:${s}`, details: {} })));
}

/**
 * How long a write waits for the budget now (0: it may start), from the key's audit rows of the last hour, oldest first:
 * per-minute and per-hour budgets (bulk actions get a share), and a pause after a secondary-limit failure.
 */
export function paceWait(rows: readonly { at: string; state: string | null; error: string | null }[], bulk: boolean, now: number): number {
  const times = rows.map((r) => Date.parse(r.at));
  const inMinute = times.filter((t) => t > now - 60_000);
  const share = bulk ? BULK_SHARE : 1;
  const perMinute = Math.floor(PACE_PER_MINUTE * share);
  const perHour = Math.floor(PACE_PER_HOUR * share);
  let wait = 0;
  if (inMinute.length >= perMinute) wait = inMinute[inMinute.length - perMinute]! + 60_000 - now;
  if (times.length >= perHour) wait = Math.max(wait, times[times.length - perHour]! + 3_600_000 - now);
  const lastSecondary = rows.filter((r) => r.state === "failed" && SECONDARY_LIMIT.test(r.error ?? "")).map((r) => Date.parse(r.at)).at(-1);
  if (lastSecondary !== undefined) wait = Math.max(wait, lastSecondary + SECONDARY_PAUSE_MS - now);
  return wait > 0 ? Math.max(wait, 1) : 0;
}

/** The rows of the last hour that count against the keys' budgets, oldest first. */
async function paceRows(db: Db, keys: readonly { identity: string; owner: string }[], now: number) {
  const q = queryDb(db);
  const pairs = [...new Map(keys.map((k) => [`${k.identity}\t${k.owner}`, [k.identity, k.owner] as const])).values()];
  return await q.all(q.k.selectFrom(AUDIT)
    .select((eb) => ["at", kx.jsonText(db, valid(db, eb), "$.identity").as("identity"), kx.jsonText(db, valid(db, eb), "$.paceOwner").as("owner"),
      kx.jsonText(db, valid(db, eb), "$.state").as("state"), kx.jsonText(db, valid(db, eb), "$.error").as("error")])
    .where("at", ">=", new Date(now - PACE_WINDOW_MS).toISOString())
    .where((eb) => kx.tupleIn(db, [kx.jsonText(db, valid(db, eb), "$.identity"), kx.jsonText(db, valid(db, eb), "$.paceOwner")], pairs, ["text", "text"]))
    .orderBy("at").orderBy(kx.rowid(AUDIT)));
}

/**
 * Inserts the `started` row after checking the pacing window under the writer lock; `pace: null` inserts without the check.
 * The caller sleeps for `wait` and retries. Call it outside a transaction: the row must commit before the GitHub call.
 */
export async function beginWrite(db: Db, o: { at: string; login: string; action: string; target: string; details: Details; pace: WritePace | null }): Promise<{ id: number; paceOwner: string | null } | { wait: number }> {
  const q = queryDb(db);
  const insert = async (d: Details): Promise<number> => Number((await q.get(q.k.insertInto(AUDIT)
    .values({ at: o.at, login: o.login, action: o.action, target: o.target, details: JSON.stringify(d) }).returning(kx.rowid(AUDIT).as("rowid"))))!.rowid);
  const started = { ...o.details, state: "started" };
  if (!o.pace) return { id: await insert(started), paceOwner: null };
  const pace = o.pace;
  return await db.write(async () => {
    const now = Date.parse(o.at);
    const wait = paceWait(await paceRows(db, [pace], now), pace.bulk, now);
    if (wait > 0) return { wait };
    return { id: await insert({ ...started, paceOwner: pace.owner }), paceOwner: pace.owner };
  });
}

/** Writes the final `done` or `failed` details; the caller keeps `paceOwner` in them. */
export async function finishWrite(db: Db, id: number, details: Details): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.updateTable(AUDIT).set({ details: JSON.stringify(details) }).where(kx.rowid(AUDIT), "=", id));
}

/** Deletes `started` rows of writes parked at a stop. */
export async function abandonWrites(db: Db, ids: number[]): Promise<void> {
  if (!ids.length) return;
  const q = queryDb(db);
  await q.run(q.k.deleteFrom(AUDIT).where((eb) => eb.and([kx.inList(db, kx.rowid(AUDIT), ids, "bigint"), eb(kx.jsonText(db, valid(db, eb), "$.state"), "=", "started")])));
}

/** How long each key waits for the budget now, keyed `action\tidentity\towner`. */
export async function loadPaceWaits(db: Db, keys: PaceKey[], now: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!keys.length) return out;
  const rows = await paceRows(db, keys, now);
  const by = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.identity}\t${r.owner}`;
    (by.get(k) ?? by.set(k, []).get(k)!).push(r);
  }
  for (const k of keys) out.set(`${k.action}\t${k.identity}\t${k.owner}`, paceWait(by.get(`${k.identity}\t${k.owner}`) ?? [], BULK_ACTIONS.has(k.action), now));
  return out;
}

/** A resumed job's earlier successful and unfinished write rows (those with a `writeKey`), newest first, by `action\ttarget`. */
export async function loadMadeBefore(db: Db, jobId: number, before: string): Promise<Map<string, { id: number; at: string; details: Details }[]>> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom(AUDIT).select([kx.rowid(AUDIT).as("id"), "at", "action", "target", "details"]).$narrowType<{ details: string }>()
    .where("at", "<", before).where("target", "is not", null)
    .where((eb) => eb.and([
      eb(kx.jsonNum(db, valid(db, eb), "$.jobId"), "=", jobId),
      eb(kx.jsonText(db, valid(db, eb), "$.writeKey"), "is not", null),
      eb(kx.jsonText(db, valid(db, eb), "$.state"), "in", ["done", "started", "failed"]),
    ]))
    .orderBy(kx.rowid(AUDIT), "desc"));
  const out = new Map<string, { id: number; at: string; details: Details }[]>();
  for (const r of rows) {
    const key = `${r.action}\t${r.target}`;
    (out.get(key) ?? out.set(key, []).get(key)!).push({ id: Number(r.id), at: r.at, details: parseDetails(r.details) ?? {} });
  }
  return out;
}

/** The rows of earlier tries of a write (its action, target and one of its write keys), newest first, the latest 20. Keyed by the target. */
export async function loadWriteTries(db: Db, w: { action: string; target: string; keys: string[] }): Promise<{ id: number; at: string; details: Details }[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom(AUDIT).select([kx.rowid(AUDIT).as("id"), "at", "details"]).$narrowType<{ details: string }>()
    .where("target", "=", w.target).where("action", "=", w.action).where((eb) => kx.inList(db, kx.jsonText(db, valid(db, eb), "$.writeKey"), w.keys))
    .orderBy(kx.rowid(AUDIT), "desc").limit(20));
  return rows.map((r) => ({ id: Number(r.id), at: r.at, details: parseDetails(r.details) ?? {} }));
}

/**
 * The URLs and ids of what the writes on `target`, or of the action on any target, made since `since` (and a little earlier: a row holds
 * the time its write began): a write whose answer was lost made none of them.
 */
export async function loadTakenWrites(db: Db, w: { target: string; action: string; since: string }): Promise<Set<string>> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom(AUDIT).select("details").$narrowType<{ details: string }>()
    .where("at", ">=", new Date(Date.parse(w.since) - 3_600_000).toISOString()).where((eb) => eb.or([eb("target", "=", w.target), eb("action", "=", w.action)]))
    .where((eb) => eb(kx.jsonText(db, valid(db, eb), "$.state"), "=", "done")));
  return new Set(rows.flatMap((r) => { const d = parseDetails(r.details); return [d?.url, d?.review, d?.ghsa].filter((v): v is string => typeof v === "string" && v !== ""); }));
}

// ---- readers ---------------------------------------------------------------------------------------------------------

const cols = () => [kx.rowid(AUDIT).as("rowid"), "at", "login", "action", "target", "details"] as const;

/** Keyed reader: `since` is inclusive, `until` exclusive; rows order by `(at, rowid)`. */
export async function listAudit(db: Db, f: AuditFilter): Promise<AuditRow[]> {
  if (f.targets && !f.targets.length) return [];
  if (f.actions && !f.actions.length) return [];
  const q = queryDb(db);
  const dir = f.order ?? "asc";
  let s = q.k.selectFrom(AUDIT).select(cols())
    .where((eb) => eb.and([
      ...(f.targets ? [kx.inList(db, "target", f.targets)] : []),
      ...(f.actions ? [kx.inList(db, "action", f.actions)] : []),
      ...(f.since !== undefined ? [eb("at", ">=", f.since)] : []),
      ...(f.until !== undefined ? [eb("at", "<", f.until)] : []),
      ...whereOf(db, eb, f.where),
    ]))
    .orderBy("at", dir).orderBy(kx.rowid(AUDIT), dir);
  if (f.limit !== undefined) s = s.limit(f.limit);
  return (await q.all(s)).map(toRow);
}

/** The same read for many targets at once, oldest first. */
export async function loadAuditActions(db: Db, targets: string[], actions: string[]): Promise<Map<string, AuditRow[]>> {
  const out = new Map<string, AuditRow[]>();
  for (const r of await listAudit(db, { targets, actions })) (out.get(r.target!) ?? out.set(r.target!, []).get(r.target!)!).push(r);
  return out;
}

/** Latest `at`, keyed by target when `targets` is given, else by action. */
export async function loadAuditMax(db: Db, action: string | readonly string[], targets?: readonly string[]): Promise<Map<string, string>> {
  const actions = typeof action === "string" ? [action] : [...action];
  if (!actions.length || (targets && !targets.length)) return new Map();
  const q = queryDb(db);
  if (targets) {
    const rows = await q.all(q.k.selectFrom(AUDIT).select((eb) => ["target as key", eb.fn.max<string>("at").as("at")]).$narrowType<{ key: string }>()
      .where(kx.inList(db, "action", actions)).where(kx.inList(db, "target", [...targets])).groupBy("target"));
    return new Map(rows.map((r) => [r.key, r.at]));
  }
  const rows = await q.all(q.k.selectFrom(AUDIT).select((eb) => ["action as key", eb.fn.max<string>("at").as("at")]).where(kx.inList(db, "action", actions)).groupBy("action"));
  return new Map(rows.map((r) => [r.key, r.at]));
}

/** Counts audit rows; `not.state` leaves out rows in that state. */
export async function countAudit(db: Db, f: { action: string | string[]; since: string; where?: AuditWhere; not?: { state?: string } }): Promise<number> {
  const q = queryDb(db);
  const actions = typeof f.action === "string" ? [f.action] : f.action;
  const row = await q.get(q.k.selectFrom(AUDIT).select((eb) => eb.fn.countAll<number>().as("n"))
    .where((eb) => eb.and([
      kx.inList(db, "action", actions), eb("at", ">=", f.since), ...whereOf(db, eb, f.where),
      ...(f.not?.state !== undefined ? [eb.or([eb(kx.jsonText(db, valid(db, eb), "$.state"), "is", null), eb(kx.jsonText(db, valid(db, eb), "$.state"), "<>", f.not.state)])] : []),
    ])));
  return Number(row?.n ?? 0);
}

/**
 * Items whose last successful `assign` or `unassign` is an assign, with the assignee and run it recorded; an item whose last
 * one is an unassign is absent. The actions are literals so the inner read walks the `audit_assign` partial index.
 */
export async function loadAssignments(db: Db, scope: { repo?: string } | { refs: string[] }): Promise<Map<string, { assignee: string | null; run: string | null }>> {
  if ("refs" in scope && !scope.refs.length) return new Map();
  const q = queryDb(db);
  const repo = "repo" in scope ? scope.repo : undefined;
  const rows = await q.all(q.k.selectFrom(AUDIT).select(["target", "details"]).where("action", "=", "assign")
    .where((eb) => eb(kx.rowid(AUDIT), "in", eb.selectFrom("main.audit as a2").select((s) => s.fn.max<number>(kx.rowid(AUDIT, "a2")).as("m"))
      .where("a2.action", "in", [kx.literal("assign"), kx.literal("unassign")])
      .where((w) => w.not(kx.like(db, w.fn.coalesce("a2.details", w.val("")), w.val('%"error":%'))))
      .$if(repo !== undefined, (b) => b.where("a2.target", ">=", `${repo}#`).where("a2.target", "<", `${repo}$`))
      .$if("refs" in scope, (b) => b.where(kx.inList(db, "a2.target", "refs" in scope ? scope.refs : [])))
      .groupBy("a2.target"))));
  const out = new Map<string, { assignee: string | null; run: string | null }>();
  for (const r of rows) {
    if (r.target === null) continue;
    const d = parseDetails(r.details);
    out.set(r.target, { assignee: str(d?.assignee), run: str(d?.run) });
  }
  return out;
}

/**
 * The create each held follow-up's filing recorded: the latest `act-open-issue` row of its id no older than `since` (when the filing
 * began), with the issue once the row is done with its URL, else null (the create is still running, failed, or lost its answer). No entry: no create was begun, or it is known to have made nothing (it never went out, or GitHub refused it).
 */
export async function loadHeldIssueAudits(db: Db, held: { id: number; since: string }[]): Promise<Map<number, { issue: { number: number; url: string } | null }>> {
  const out = new Map<number, { issue: { number: number; url: string } | null }>();
  if (!held.length) return out;
  const since = new Map(held.map((h) => [h.id, h.since]));
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom(AUDIT).select(["at", "details"]).$narrowType<{ details: string }>()
    .where("action", "=", "act-open-issue").where((eb) => kx.inList(db, kx.jsonNum(db, valid(db, eb), "$.held"), [...since.keys()], "bigint"))
    .orderBy(kx.rowid(AUDIT)));
  for (const r of rows) {
    const d = parseDetails(r.details);
    if (!d || typeof d.held !== "number" || r.at < since.get(d.held)! || (d.state !== "done" && !unclearWrite(d))) continue;
    const m = d.state === "done" ? /\/issues\/(\d+)/.exec(String(d.url ?? "")) : null;
    out.set(d.held, { issue: m ? { number: Number(m[1]), url: String(d.url) } : null });
  }
  return out;
}

/** Actions whose rows carry the id of a comment or review AutoCraft posted. */
const COMMENT_ACTIONS = Object.keys(GITHUB_ACTIONS).filter((a) => /comment|review|claim/.test(a));

/** Ids of comments AutoCraft posted: the number after `#issuecomment-` in a stored URL, and review node ids. */
export async function loadPostedCommentIds(db: Db, o: { since?: string }): Promise<{ numbers: Set<string>; nodes: Set<string> }> {
  const numbers = new Set<string>(), nodes = new Set<string>();
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom(AUDIT).select("details").where(kx.inList(db, "action", COMMENT_ACTIONS))
    .$if(o.since !== undefined, (b) => b.where("at", ">=", o.since!))
    .where((eb) => eb.or([kx.like(db, "details", eb.val("%issuecomment-%")), kx.like(db, "details", eb.val('%"review"%'))])));
  for (const r of rows) {
    for (const m of (r.details ?? "").matchAll(/#issuecomment-(\d+)/g)) numbers.add(m[1]!);
    const v = parseDetails(r.details)?.review;
    if (typeof v === "string") nodes.add(v);
  }
  return { numbers, nodes };
}

/** AutoCraft's GitHub writes per item (the actions of `GITHUB_ACTIONS` and the `*-push` rows), oldest first. */
export async function loadWriteLog(db: Db, refs: string[]): Promise<Map<string, WriteLogRow[]>> {
  const out = new Map<string, WriteLogRow[]>();
  if (!refs.length) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom(AUDIT).select(cols()).$narrowType<{ target: string }>()
    .where(kx.inList(db, "target", refs))
    .where((eb) => eb.or([kx.inList(db, "action", Object.keys(GITHUB_ACTIONS)), kx.like(db, "action", eb.val("%-push"))]))
    .orderBy("at").orderBy(kx.rowid(AUDIT)));
  for (const r of rows) {
    const d = parseDetails(r.details) ?? {};
    const row: WriteLogRow = {
      rowid: Number(r.rowid), at: r.at, action: r.action, target: r.target, state: str(d.state) ?? "started", identity: str(d.identity),
      commit: str(d.commit) ?? str(d.sha), url: str(d.url), review: str(d.review), head: str(d.head),
      labels: Array.isArray(d.labels) ? d.labels.filter((x): x is string => typeof x === "string") : [],
      jobId: typeof d.jobId === "number" ? d.jobId : null, error: str(d.error),
    };
    (out.get(r.target) ?? out.set(r.target, []).get(r.target)!).push(row);
  }
  return out;
}

/**
 * The admin audit log. `visible` set means a viewer who is not an operator: only `actions` are listed, and security rows
 * (`<repo>:...` targets) only of the visible repos. `q` matches the login, action or target as a substring; `before` keeps rows
 * with a smaller rowid.
 */
export async function listAuditPage(db: Db, f: AuditPageFilter): Promise<{ total: number; rows: AuditRow[] }> {
  const q = queryDb(db);
  const filter = (eb: kx.AnyEb): Expression<SqlBool> => {
    const c: Expression<SqlBool>[] = [];
    if (f.login) c.push(eb.or([kx.ciEq(db, "login", eb.val(f.login)), kx.ciEq(db, "target", eb.val(f.login))]));
    if (f.action) c.push(eb("action", "=", f.action));
    if (f.q) {
      const pat = eb.val(`%${kx.likeEscape(f.q)}%`);
      c.push(eb.or([kx.like(db, "login", pat, "\\"), kx.like(db, "action", pat, "\\"), kx.like(db, "target", pat, "\\")]));
    }
    if (f.before !== undefined) c.push(eb(kx.rowid(AUDIT), "<", f.before));
    if (f.visible !== undefined || f.actions !== undefined) {
      c.push(kx.inList(db, "action", f.actions ?? []));
      const colon = eb.fn<number>("instr", ["target", eb.val(":")]);
      const repoOf = eb.case().when(colon, ">", 0).then(eb.fn<string>("substr", ["target", eb.lit(1), eb(colon, "-", eb.lit(1))])).else(eb.ref("target")).end();
      c.push(eb.or([eb.not(kx.like(db, "action", eb.val("security-%"))), kx.inList(db, repoOf, ["", ...(f.visible ?? [])])]));
    }
    return eb.and(c);
  };
  const [total, rows] = await db.together(() => Promise.all([
    q.get(q.k.selectFrom(AUDIT).select((eb) => eb.fn.countAll<number>().as("n")).where(filter)),
    q.all(q.k.selectFrom(AUDIT).select(cols()).where(filter).orderBy("at", "desc").orderBy(kx.rowid(AUDIT), "desc").limit(f.limit).offset(f.offset)),
  ]));
  return { total: Number(total?.n ?? 0), rows: rows.map(toRow) };
}

/** Item-trace fingerprint: rows, newest rowid and total detail length of the item's audit rows. */
export async function loadAuditCounts(db: Db, ref: string): Promise<{ n: number; newest: number; length: number }> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom(AUDIT).select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max<number | null>(kx.rowid(AUDIT)).as("newest"),
    eb.fn.sum<number | null>(eb.fn("length", [eb.fn.coalesce("details", eb.val(""))])).as("length")]).where("target", "=", ref));
  return { n: Number(r?.n ?? 0), newest: Number(r?.newest ?? 0), length: Number(r?.length ?? 0) };
}
