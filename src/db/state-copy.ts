// Once: copies the state that code kept in settings rows into the module state tables (the block of src/schema.sql that
// starts at sync_state) and fills the columns added with them. The settings rows stay: processes of the previous release
// keep reading and writing them until they exit, and a later release deletes them.
//
// Runs on SQLite from connect() (src/db.ts) and on Postgres from migratePg (src/db/pg-triggers.ts). The work is split into
// units of one transaction each; a backfill of a large table runs one unit per id range, so no transaction holds row locks
// on many rows. Every unit is idempotent (inserts skip present keys, updates fill only empty columns), so a run cut short
// is completed by the next one; STATE_COPY_DONE, written last with the time the copy started, makes later runs do nothing.
// What older processes write to the old places after the copy is carried over at the switch (src/db/switch-over.ts).
import type { DatabaseSync } from "node:sqlite";
import type { Migration, PgClient } from "./pg-migrate.ts";

export const STATE_COPY_DONE = "state_copy_done";

/** The states of a pre-approved merge leg in progress (src/preapproval/index.ts ACTIVE), and the index that allows one per PR. */
export const ACTIVE_LEG_STATES = ["fixup", "review", "ci", "queued"] as const;
export const ACTIVE_LEG_INDEX = "preapprovals_active";

export type Value = string | number | null;
type Row = Record<string, unknown>;
type Stmt = { sql: string; params: Value[] };

/** A copy or backfill. With `range`, one unit runs per span of `size` ids of `range.col`, else one unit runs. */
export interface Task {
  label: string;
  /** The table the unit writes, named in the Postgres lock-wait log. */
  table: string;
  range?: { table: string; col: string; size: number };
  read?: (lo: number, hi: number) => Stmt;
  writes: (rows: Row[], lo: number, hi: number) => Stmt[];
}

const stmt = (sql: string, ...params: Value[]): Stmt => ({ sql, params });

/** Multi-row inserts of `rows` that skip keys already present, 200 rows a statement. */
function insert(p: string, table: string, cols: string[], rows: Value[][]): Stmt[] {
  const out: Stmt[] = [];
  const tuple = `(${cols.map(() => "?").join(", ")})`;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    out.push({ sql: `INSERT INTO ${p}${table} (${cols.join(", ")}) VALUES ${chunk.map(() => tuple).join(", ")} ON CONFLICT DO NOTHING`, params: chunk.flat() });
  }
  return out;
}

const int = (v: string | undefined): number | null => (v !== undefined && /^-?[0-9]{1,15}$/.test(v.trim()) ? Number(v.trim()) : null);
const json = (v: string): unknown => {
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
};
const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const whole = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

const SYNC_TEXT: Record<string, string> = {
  org_high_water: "org_high_water", full_sync_cursor: "full_sync_cursor", search_catchup_at: "search_catchup_at",
  repos_refreshed_at: "repos_refreshed_at", main_ci_polled_at: "main_ci_polled_at", releases_polled_at: "releases_polled_at",
  rate_reset_at: "sync_rate_reset_at", author_ids_backfilled_at: "author_ids_backfilled", author_ids_error: "author_ids_error",
  app_install_sweep_at: "app_install_sweep_at",
};
const SYNC_INT: Record<string, string> = {
  releases_offset: "releases_offset", rate_remaining: "sync_rate_remaining", points_last_run: "sync_points_last_run",
  full_points_last_run: "sync_full_points_last_run",
};
const LANE_MARKS: Record<string, string> = {
  pipeline_planned_at: "planned_at", pipeline_seqs_seen: "seqs_seen", pipeline_wake_at: "wake_at", pipeline_status: "status",
  runner_heartbeat: "heartbeat", security_poll_at: "security_poll_at",
};
const LANE_CURSORS: Record<string, string> = { pipeline_review_cursor: "review", pipeline_verify_cursor: "verify" };
const BUILD_KEYS = new Set(["warm_report", "worker_update_pending", "worker_update_failures", "warm_gc_at", "warm_trimmed_publish", "leader:runner:endpoint"]);
const BUILD_PREFIXES = ["warm_bytes:", "warm_rebuild:"];

/** The settings rows the copy reads: exact keys, and prefixes. */
export const COPIED_SETTINGS: { keys: string[]; prefixes: string[] } = {
  keys: [...Object.values(SYNC_TEXT), ...Object.values(SYNC_INT), ...Object.keys(LANE_MARKS), ...Object.keys(LANE_CURSORS), ...BUILD_KEYS, "classify_run", "liveness_at", "liveness_open"],
  prefixes: [...BUILD_PREFIXES, ...["merge", "push", "comment", "fixissue", "labels", "mainfix", "prstatus", "ci"].map((s) => `${s}_approved:`),
    "pipeline_fp:", "limit_reset_at:", "dupe_drop:", "review_stale:", "review_rerun:", "review_fail:", "mergeable_unknown:", "batch_size:"],
};

const APPROVAL = /^(merge|push|comment|fixissue|labels|mainfix|prstatus|ci)_approved:(.+)$/;
const STALE = /^review_stale:(.+)#([0-9]+)$/;
const RERUN = /^review_rerun:(.+)#([0-9]+):([0-9]{4}-[0-9]{2}-[0-9]{2})$/;
const FAIL = /^review_fail:(.+)#([0-9]+)@(.+)$/;
const UNKNOWN = /^mergeable_unknown:(.+)#([0-9]+)$/;

type ReviewMarks = { stale_at: string | null; rerun_day: string | null; rerun_count: number; fail_head: string | null; fail_count: number; fail_at: string | null };

/** A state table's rows as the settings rows hold them, in the order of `cols`. */
export type StateRows = { table: string; cols: string[]; rows: Value[][] };
/** Everything the settings rows hold of the state tables; `resets` are the daily-limit resets [step, time]. */
export type SettingsState = { tables: Record<StateTable, StateRows>; resets: [string, string][] };
export type StateTable = "sync_state" | "repo_step_approvals" | "lane_state" | "dupe_drops" | "review_state" | "merge_state" | "merge_repo_state" | "build_state" | "classify_state" | "liveness_state";

/** The state rows the settings rows `rows` hold; a time they do not carry is `now`. */
export function settingsState(rows: readonly Row[], now: string): SettingsState {
  const kv = new Map<string, string>();
  for (const r of rows) if (typeof r.key === "string" && typeof r.value === "string") kv.set(r.key, r.value);

  const sync: [string, Value][] = [
    ...Object.entries(SYNC_TEXT).flatMap(([col, key]): [string, Value][] => (kv.has(key) ? [[col, kv.get(key)!]] : [])),
    ...Object.entries(SYNC_INT).flatMap(([col, key]): [string, Value][] => (int(kv.get(key)) !== null ? [[col, int(kv.get(key))]] : [])),
  ];

  const resets: [string, string][] = [];
  const approvals: Value[][] = [];
  const lanes: Value[][] = [];
  const drops: Value[][] = [];
  const unknown: Value[][] = [];
  const sizes: Value[][] = [];
  const build: Value[][] = [];
  const reviews = new Map<string, { repo: string; number: number; m: ReviewMarks }>();
  const marksOf = (repo: string, number: number): ReviewMarks => {
    const k = `${repo}#${number}`;
    let e = reviews.get(k);
    if (!e) reviews.set(k, e = { repo, number, m: { stale_at: null, rerun_day: null, rerun_count: 0, fail_head: null, fail_count: 0, fail_at: null } });
    return e.m;
  };

  for (const [key, value] of kv) {
    let m: RegExpExecArray | null;
    if ((m = APPROVAL.exec(key))) {
      // A value that does not parse counts as no approval today.
      const o = obj(json(value));
      if (o) approvals.push([m[2]!, m[1]!, str(o.by) ?? "", str(o.at) ?? now]);
    } else if (key.startsWith("pipeline_fp:")) {
      const rest = key.slice("pipeline_fp:".length);
      const bar = rest.indexOf("|");
      const o = obj(json(value));
      if (bar > 0 && o && typeof o.fp === "string") lanes.push(["fp", rest.slice(0, bar), rest.slice(bar + 1), o.fp, whole(o.job), now]);
    } else if (key.startsWith("limit_reset_at:")) {
      const step = key.slice("limit_reset_at:".length);
      lanes.push(["reset", step, "", value, null, now]);
      resets.push([step, value]);
    } else if (key in LANE_CURSORS) lanes.push(["cursor", LANE_CURSORS[key]!, "", value, null, now]);
    else if (key in LANE_MARKS) lanes.push(["mark", LANE_MARKS[key]!, "", value, null, now]);
    else if (key.startsWith("dupe_drop:")) {
      const rest = key.slice("dupe_drop:".length);
      const colon = rest.indexOf(":");
      const bar = value.indexOf("|");
      if (colon > 0 && bar > 0) drops.push([rest.slice(0, colon), rest.slice(colon + 1), value.slice(0, bar), value.slice(bar + 1) || now]);
    } else if ((m = STALE.exec(key))) marksOf(m[1]!, Number(m[2])).stale_at = value;
    else if ((m = RERUN.exec(key))) {
      // The newest day counts; the code deleted the other days' keys as it wrote.
      const r = marksOf(m[1]!, Number(m[2]));
      if (r.rerun_day === null || m[3]! > r.rerun_day) Object.assign(r, { rerun_day: m[3]!, rerun_count: int(value) ?? 0 });
    } else if ((m = FAIL.exec(key))) {
      const r = marksOf(m[1]!, Number(m[2]));
      const [n, at] = value.split("|");
      if (r.fail_head === null || (at ?? "") > (r.fail_at ?? "")) Object.assign(r, { fail_head: m[3]!, fail_count: int(n) ?? 0, fail_at: at ?? null });
    } else if ((m = UNKNOWN.exec(key))) {
      const o = obj(json(value));
      if (o && typeof o.head === "string" && typeof o.since === "string") unknown.push([m[1]!, Number(m[2]), o.head, o.since, whole(o.reads) ?? 0, whole(o.rereads) ?? 0, o.stuck === true ? 1 : 0]);
    } else if (key.startsWith("batch_size:")) {
      const n = int(value);
      if (n !== null && n >= 1) sizes.push([key.slice("batch_size:".length), n, now]);
    } else if (BUILD_KEYS.has(key) || BUILD_PREFIXES.some((x) => key.startsWith(x))) build.push([key, value, now]);
  }

  const of = <T extends StateTable>(table: T, cols: string[], list: Value[][]): StateRows => ({ table, cols, rows: list });
  return {
    resets,
    tables: {
      sync_state: of("sync_state", ["id", ...sync.map(([c]) => c)], sync.length ? [[1, ...sync.map(([, v]) => v)]] : []),
      repo_step_approvals: of("repo_step_approvals", ["repo", "step", "by", "at"], approvals),
      lane_state: of("lane_state", ["kind", "step", "repo", "value", "job_id", "at"], lanes),
      dupe_drops: of("dupe_drops", ["repo", "key", "hash", "at"], drops),
      review_state: of("review_state", ["repo", "number", "stale_at", "rerun_day", "rerun_count", "fail_head", "fail_count", "fail_at"],
        [...reviews.values()].map(({ repo, number, m }) => [repo, number, m.stale_at, m.rerun_day, m.rerun_count, m.fail_head, m.fail_count, m.fail_at])),
      merge_state: of("merge_state", ["repo", "number", "head", "since", "reads", "rereads", "stuck"], unknown),
      merge_repo_state: of("merge_repo_state", ["repo", "batch_size", "updated_at"], sizes),
      build_state: of("build_state", ["key", "value", "updated_at"], build),
      classify_state: of("classify_state", ["kind", "repo", "number", "value", "at"], kv.has("classify_run") ? [["current_run", "", 0, kv.get("classify_run")!, now]] : []),
      liveness_state: of("liveness_state", ["id", "checked_at", "open"],
        kv.has("liveness_at") || kv.has("liveness_open") ? [[1, kv.get("liveness_at") ?? null, int(kv.get("liveness_open"))]] : []),
    },
  };
}

/** The inserts that copy the settings state rows into their tables, and the stage_limits resets. */
function settingsWrites(p: string, rows: Row[], now: string): Stmt[] {
  const s = settingsState(rows, now);
  return [
    ...s.resets.map(([step, at]) => stmt(`UPDATE ${p}stage_limits SET reset_at = ? WHERE step = ? AND reset_at IS NULL`, at, step)),
    ...Object.values(s.tables).flatMap((t) => insert(p, t.table, t.cols, t.rows)),
  ];
}

/** The backfills that fill only what is empty; the switch runs them again for rows older processes wrote after the copy. */
export function backfills(p: string): Record<"agentRuns" | "callItems" | "batchPrs" | "batchForks" | "helpers" | "alerts" | "groups" | "groupItems", Task> {
  const first = (col: string) => `(SELECT i.${col} FROM ${p}agent_run_items i WHERE i.run_id = agent_runs.id ORDER BY i.repo, i.number LIMIT 1)`;
  const token = (col: string) => `(SELECT t.${col} FROM ${p}mcp_tokens t WHERE t.id = remote_helpers.token_id)`;
  return {
    agentRuns: {
      label: "agent_runs first item", table: "agent_runs", range: { table: "agent_runs", col: "id", size: 2000 },
      writes: (_, lo, hi) => [stmt(`UPDATE ${p}agent_runs SET first_repo = ${first("repo")}, first_number = ${first("number")}
        WHERE id >= ? AND id < ? AND first_repo IS NULL AND EXISTS (SELECT 1 FROM ${p}agent_run_items i WHERE i.run_id = agent_runs.id)`, lo, hi)],
    },
    callItems: {
      label: "remote_call_items", table: "remote_call_items",
      read: () => stmt(`SELECT id, items FROM ${p}remote_calls WHERE state IN ('queued', 'leased')`),
      writes: (rows) => insert(p, "remote_call_items", ["call_id", "pos", "repo", "number"], rows.flatMap((r) => {
        const items = typeof r.items === "string" ? json(r.items) : undefined;
        if (!Array.isArray(items)) return [];
        return items.flatMap((it, pos): Value[][] => {
          const o = obj(it);
          return o && typeof o.repo === "string" && whole(o.number) !== null ? [[Number(r.id), pos, o.repo, o.number as number]] : [];
        });
      })),
    },
    batchPrs: {
      label: "merge_batch_prs repo", table: "merge_batch_prs", range: { table: "merge_batch_prs", col: "batch_id", size: 5000 },
      writes: (_, lo, hi) => [stmt(`UPDATE ${p}merge_batch_prs SET repo = (SELECT b.repo FROM ${p}merge_batches b WHERE b.id = merge_batch_prs.batch_id)
        WHERE batch_id >= ? AND batch_id < ? AND repo IS NULL`, lo, hi)],
    },
    batchForks: {
      // Batches pushed before the fork was stored: the push's audit row names it (the newest one wins).
      label: "merge_batches fork", table: "merge_batches", range: { table: "merge_batches", col: "id", size: 2000 },
      read: (lo, hi) => stmt(`SELECT b.id AS id, a.details AS details FROM ${p}merge_batches b
        JOIN ${p}audit a ON a.action = 'batch-push' AND a.target = b.repo || ':' || b.branch
        WHERE b.id >= ? AND b.id < ? AND b.fork IS NULL AND b.state <> 'checking' ORDER BY b.id, a.at, a.rowid`, lo, hi),
      writes: (rows) => {
        const forks = new Map<number, string>();
        for (const r of rows) {
          const f = typeof r.details === "string" ? obj(json(r.details))?.fork : undefined;
          if (typeof f === "string" && f) forks.set(Number(r.id), f);
        }
        return [...forks].map(([id, fork]) => stmt(`UPDATE ${p}merge_batches SET fork = ? WHERE id = ? AND fork IS NULL`, fork, id));
      },
    },
    helpers: {
      label: "remote_helpers runner columns", table: "remote_helpers",
      writes: () => [stmt(`UPDATE ${p}remote_helpers SET idle_claim_at = ${token("idle_claim_at")}, idle_tiers = ${token("idle_tiers")},
          idle_repos = ${token("idle_repos")}, machine = ${token("machine")}
        WHERE idle_claim_at IS NULL AND idle_tiers IS NULL AND idle_repos IS NULL AND machine IS NULL
          AND EXISTS (SELECT 1 FROM ${p}mcp_tokens t WHERE t.id = remote_helpers.token_id)`)],
    },
    alerts: {
      label: "discord_alert_msgs workflow key", table: "discord_alert_msgs",
      read: () => stmt(`SELECT decision_id, user_hash FROM ${p}discord_alert_msgs WHERE workflow_id IS NULL AND substr(decision_id, 1, 3) = 'wf:'`),
      writes: (rows) => rows.flatMap((r) => {
        const m = typeof r.decision_id === "string" ? /^wf:([0-9]{1,15}):(.+)$/.exec(r.decision_id) : null;
        return m ? [stmt(`UPDATE ${p}discord_alert_msgs SET workflow_id = ?, rec_at = ? WHERE decision_id = ? AND user_hash = ?
          AND NOT EXISTS (SELECT 1 FROM ${p}discord_alert_msgs o WHERE o.user_hash = ? AND o.workflow_id = ? AND o.rec_at = ?)`,
          Number(m[1]), m[2]!, r.decision_id as string, r.user_hash as string, r.user_hash as string, Number(m[1]), m[2]!)] : [];
      }),
    },
    groups: {
      label: "dupe_groups id", table: "dupe_groups", range: { table: "dupe_groups", col: "rowid", size: 5000 },
      writes: (_, lo, hi) => [stmt(`UPDATE ${p}dupe_groups SET id = decision_id WHERE rowid >= ? AND rowid < ? AND id IS NULL`, lo, hi)],
    },
    groupItems: {
      label: "dupe_group_items group id", table: "dupe_group_items", range: { table: "dupe_group_items", col: "rowid", size: 5000 },
      writes: (_, lo, hi) => [stmt(`UPDATE ${p}dupe_group_items SET group_id = decision_id WHERE rowid >= ? AND rowid < ? AND group_id IS NULL`, lo, hi)],
    },
  };
}

function tasks(p: string, now: string): Task[] {
  return [
    {
      label: "settings", table: "settings",
      read: () => stmt(`SELECT key, value FROM ${p}settings WHERE value IS NOT NULL`),
      writes: (rows) => settingsWrites(p, rows, now),
    },
    {
      label: "classify_state", table: "classify_state",
      writes: () => [stmt(`INSERT INTO ${p}classify_state (kind, repo, number, value, at)
        SELECT 'jev_failed', repo, number, jev_failed_hash, CAST(? AS TEXT) FROM ${p}items WHERE jev_failed_hash IS NOT NULL ON CONFLICT DO NOTHING`, now)],
    },
    ...Object.values(backfills(p)),
    {
      label: "done", table: "settings",
      writes: () => [stmt(`INSERT INTO ${p}settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING`, STATE_COPY_DONE, now)],
    },
  ];
}

export const boundsSql = (t: Task, p: string): string => `SELECT min(${t.range!.col}) AS lo, max(${t.range!.col}) AS hi FROM ${p}${t.range!.table}`;

/** The [lo, hi) id spans a task's units cover: one unit without a range, none for an empty table. */
export function spans(t: Task, bounds: Row | undefined): [number, number][] {
  if (!t.range) return [[0, 0]];
  if (bounds?.lo === null || bounds?.lo === undefined) return [];
  const out: [number, number][] = [];
  for (let lo = Number(bounds.lo), hi = Number(bounds.hi); lo <= hi; lo += t.range.size) out.push([lo, lo + t.range.size]);
  return out;
}

const doneSql = (p: string): string => `SELECT 1 AS done FROM ${p}settings WHERE key = '${STATE_COPY_DONE}'`;

/** Indexes of a table the copy rewrites, which it would otherwise write row by row: both engines build them after it. */
export const AFTER_COPY_INDEXES: readonly string[] = ["agent_runs_ended", "agent_runs_first"];
/** The name of the index `create` makes. */
const indexName = (create: string): string | undefined => /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (?:main\.)?(\w+)/.exec(create)?.[1];
export const builtAfterCopy = (create: string): boolean => AFTER_COPY_INDEXES.includes(indexName(create) ?? "");

export function copyStateSqlite(db: DatabaseSync, now: string = new Date().toISOString()): void {
  if (db.prepare(doneSql("main.")).get()) return;
  for (const t of tasks("main.", now)) {
    const bounds = t.range ? db.prepare(boundsSql(t, "main.")).get() as Row | undefined : undefined;
    for (const [lo, hi] of spans(t, bounds)) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const read = t.read?.(lo, hi);
        const rows = read ? db.prepare(read.sql).all(...read.params) as Row[] : [];
        for (const w of t.writes(rows, lo, hi)) db.prepare(w.sql).run(...w.params);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
  }
}

/** `?` placeholders as Postgres's numbered ones; the statements here have no `?` anywhere else. */
const numbered = (sql: string): string => {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
};

export async function copyStatePg(client: PgClient, m: Migration, now: string = new Date().toISOString()): Promise<void> {
  const q = async (s: Stmt) => (await client.query(numbered(s.sql), s.params)).rows;
  if ((await q(stmt(doneSql("")))).length) return;
  for (const t of tasks("", now)) {
    const bounds = t.range ? (await q(stmt(boundsSql(t, ""))))[0] : undefined;
    for (const [lo, hi] of spans(t, bounds)) {
      await m.step({
        label: `state copy: ${t.label}${t.range ? ` ${lo}-${hi - 1}` : ""}`, table: t.table,
        run: async () => {
          const read = t.read?.(lo, hi);
          const rows = read ? await q(read) : [];
          for (const w of t.writes(rows, lo, hi)) await q(w);
        },
      });
    }
  }
}

/**
 * Cancels every active pre-approved merge leg of a PR but the newest (and ends its operator fix-up), so the unique index
 * ACTIVE_LEG_INDEX can be built. Runs before the index exists; the code refused a second active leg, so this finds rows only
 * where two requests raced.
 */
function oneActiveLeg(p: string, now: string): Stmt[] {
  const active = (a: string) => `${a}state IN (${ACTIVE_LEG_STATES.map((s) => `'${s}'`).join(", ")})`;
  const older = `${active("")} AND EXISTS (SELECT 1 FROM ${p}preapprovals n WHERE n.repo = preapprovals.repo AND n.number = preapprovals.number AND ${active("n.")} AND n.id > preapprovals.id)`;
  return [
    stmt(`UPDATE ${p}operator_fixups SET state = 'ended' WHERE state <> 'ended' AND id IN (SELECT fix_id FROM ${p}preapprovals WHERE fix_id IS NOT NULL AND ${older})`),
    stmt(`UPDATE ${p}preapprovals SET state = 'cancelled', reason = 'a newer pre-approved merge of the PR is in progress', updated_at = ? WHERE ${older}`, now),
  ];
}

export function oneActiveLegSqlite(db: DatabaseSync, now: string = new Date().toISOString()): void {
  if (db.prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'index' AND name = ?").get(ACTIVE_LEG_INDEX)) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const s of oneActiveLeg("main.", now)) db.prepare(s.sql).run(...s.params);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Runs inside a migration step, before the schema step builds the index. */
export async function oneActiveLegPg(client: PgClient, now: string = new Date().toISOString()): Promise<void> {
  // An invalid index (a concurrent build that met a duplicate) counts as missing: the schema step drops and builds it again.
  const r = (await client.query(`SELECT to_regclass('preapprovals') IS NOT NULL AS t,
    COALESCE((SELECT x.indisvalid FROM pg_index x WHERE x.indexrelid = to_regclass('${ACTIVE_LEG_INDEX}')), false) AS i`)).rows[0];
  if (!r?.t || r.i) return;
  for (const s of oneActiveLeg("", now)) await client.query(numbered(s.sql), s.params);
}
