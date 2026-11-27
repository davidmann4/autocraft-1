// Leader election for the roles of which one copy may work at a time: the runner and the periodic chores. On Postgres a
// copy leads while it holds its role's lease, a row of `leader_leases` that it renews every CHECK_MS for LEASE_MS ahead
// on the server's clock; another copy waits as a standby, reads the lease every few seconds and takes it once it has
// expired. On SQLite every process of an install runs on one host, where the lock files exclude a second copy, so a
// process always leads.
//
// Fencing. Taking the lease moves the role's epoch in a write transaction, and the winner fences its writes to that
// epoch (src/db/fence.ts). Writes run one at a time under the writer lock, and each fenced write checks the epoch after
// taking it, so a write of the old leader either committed before the new epoch or fails.
//
// The lease connection. The leader renews on a connection of its own, outside the pools and the writer lock, so neither
// busy pools nor a long write transaction delay a renewal. A renewal names the epoch: none renews a lease another copy
// has taken, and one that changes no row means the epoch moved (`lost` aborts). When the connection fails, the next
// renewal opens another; an expired lease that no other copy took is simply renewed again.
//
// Replicas (AUTOCRAFT_RUNNER_REPLICAS). With two or more, `lost` also aborts when no renewal has succeeded for LOSS_MS
// by the wall clock (an event-loop stall counts). LOSS_MS is below LEASE_MS, so a leader cut off from the database, or
// frozen and thawed, has stopped before its lease expires and a standby can win. With one, no standby waits to take
// over, so a slow or failed renewal never stops the leader: it keeps renewing. A copy that does win meanwhile (the new
// pod of a deploy) moves the epoch, and the old leader stops at its next renewal or fenced write.
import { hostname } from "node:os";
import type * as Pg from "pg";
import type { Compilable } from "kysely";
import { envVar } from "../env.ts";
import type { Db } from "./index.ts";
import { dbTarget, isPgUrl, loadPg } from "./open.ts";
import { pgConnectionString, SERVER_KEEPALIVE, setSession, within } from "./postgres.ts";
import { isFenced, type LeaderRole } from "./fence.ts";
import { queryDb, type QueryDb } from "./query-db.ts";
import { sql } from "./sql.ts";

/**
 * Exit code of a process that lost its lease: an ordinary failure (not a signal), so its supervisor restarts it
 * (Kubernetes, Compose, systemd Restart=on-failure) as a standby.
 */
export const LOST_LEADER_EXIT = 75;

/** A standby reads the lease this often. */
export const RETRY_MS = 2_000;
/** The leader renews its lease this often. */
export const CHECK_MS = 2_000;
/** How far ahead of the server's clock a renewal sets the lease's end: above LOSS_MS with margin. */
export const LEASE_MS = 10_000;
/** Longest time without a successful renewal before the leader of two or more replicas gives up: below LEASE_MS. */
export const LOSS_MS = 8_000;
/** Longest wait for a query on the lease connection. */
const QUERY_MS = 3_000;
/** Leader and standbys write their status row this often (health checks read it). */
export const BEAT_MS = 10_000;
/** Standby rows not written for this long are removed by the leader. */
const STANDBY_KEEP_MS = 10 * 60_000;
const CONNECT_MS = 5_000;

/** Copies of the runner and periodic containers the install runs (AUTOCRAFT_RUNNER_REPLICAS, default 1). */
export function runnerReplicas(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(envVar("RUNNER_REPLICAS", env));
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** Settings row the leader of `role` writes every BEAT_MS: LeaderStatus as JSON. */
export const leaderKey = (role: LeaderRole): string => `leader:${role}`;
/** Prefix of the rows standbys of `role` write, one per copy: StandbyStatus as JSON. */
export const standbyPrefix = (role: LeaderRole): string => `leader:${role}:standby:`;

/** What the server says of the lease connection: the keepalive settings in effect and the client address it sees. */
export type ConnInfo = { keepalivesIdle: string | null; userTimeout: string | null; clientAddr: string | null };
/** `replicas`: the copy's AUTOCRAFT_RUNNER_REPLICAS (absent in rows of older versions). */
export type LeaderStatus = { holder: string; epoch: number; since: string; at: string; replicas?: number; conn: ConnInfo | null };
export type StandbyStatus = { holder: string; since: string; at: string; replicas?: number };

export type Lease = {
  role: LeaderRole;
  /** 0 on SQLite, where nothing is fenced. */
  epoch: number;
  holder: string;
  /** Aborts when the lease is lost; never on SQLite. */
  lost: AbortSignal;
  /** Gives the lease up (a clean stop); the next standby takes over within RETRY_MS. */
  release(): Promise<void>;
};

export type ElectOptions = {
  /** The database (a postgres:// URL; anything else leads at once). Default: the process's configured database. */
  url?: string;
  /** Stops waiting: elect resolves null. */
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** Called once, when this copy starts to wait as a standby. */
  onStandby?: () => void;
  holder?: string;
  retryMs?: number;
  checkMs?: number;
  leaseMs?: number;
  lossMs?: number;
  beatMs?: number;
  /** Copies of this role the install runs; with one, a failed or slow renewal alone never aborts `lost`. Default runnerReplicas(). */
  replicas?: number;
  /** Runs after each status write of the leader; a fenced error from it aborts `lost`, other errors are logged. */
  onBeat?: () => Promise<void>;
};

const iso = (ms = Date.now()): string => new Date(ms).toISOString();

const pause = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done(): void {
    clearTimeout(t);
    signal?.removeEventListener("abort", done);
    resolve();
  }
  signal?.addEventListener("abort", done, { once: true });
});

async function putSetting(db: QueryDb, key: string, value: string): Promise<void> {
  await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
}

/** The server's clock in ms since 1970, `plus` ahead. */
const serverMs = (plus = 0) => sql<number>`CAST(EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS BIGINT) + ${plus}`;

type LeaseConn = { client: Pg.Client; info: ConnInfo; run: <O>(q: Compilable<O>) => Promise<O[]> };

/** The lease connection: errors and its end go to `onLost`, so a dropped connection never crashes the process. */
async function leaseClient(pg: typeof Pg.default, db: QueryDb, url: string, role: LeaderRole, log: (l: string) => void, onLost: (c: Pg.Client, why: string) => void): Promise<LeaseConn> {
  const c = new pg.Client({
    connectionString: pgConnectionString(url), application_name: `autocraft-leader-${role}`, keepAlive: true, keepAliveInitialDelayMillis: 5_000,
    connectionTimeoutMillis: CONNECT_MS,
  });
  c.on("error", (e) => onLost(c, e.message));
  c.on("end", () => onLost(c, "the connection closed"));
  const run = async <O>(q: Compilable<O>): Promise<O[]> => {
    const cq = q.compile();
    return (await within(c.query(cq.sql, cq.parameters as unknown[]), QUERY_MS, "the lease query")).rows as O[];
  };
  try {
    await c.connect();
    // A refused setting leaves the server's default; the status row shows what is in effect.
    await setSession((text) => c.query(text), SERVER_KEEPALIVE, `the ${role} lease connection`, log, QUERY_MS);
    const [row] = await run(db.k.selectNoFrom([
      sql<string | null>`current_setting('tcp_keepalives_idle', true)`.as("keepalivesIdle"),
      sql<string | null>`current_setting('tcp_user_timeout', true)`.as("userTimeout"),
      sql<string | null>`host(inet_client_addr())`.as("clientAddr"),
    ]));
    return { client: c, info: row!, run };
  } catch (e) {
    await c.end().catch(() => undefined);
    throw e;
  }
}

/**
 * Waits until this copy leads `role`, then resolves its lease; null when `signal` aborted first. The caller fences its
 * process to `lease.epoch` (setFence) before it starts work and stops at once when `lease.lost` aborts.
 */
export async function elect(handle: Db, role: LeaderRole, o: ElectOptions = {}): Promise<Lease | null> {
  const db = queryDb(handle);
  const holder = o.holder ?? `${hostname()}:${process.pid}`;
  const log = o.log ?? ((l: string) => console.log(l));
  const url = o.url ?? dbTarget();
  if (db.dialect !== "postgres" || !isPgUrl(url)) {
    return o.signal?.aborted ? null : { role, epoch: 0, holder, lost: new AbortController().signal, release: async () => {} };
  }
  const pg = await loadPg();
  const retryMs = o.retryMs ?? RETRY_MS, checkMs = o.checkMs ?? CHECK_MS, leaseMs = o.leaseMs ?? LEASE_MS, lossMs = o.lossMs ?? LOSS_MS, beatMs = o.beatMs ?? BEAT_MS;
  const replicas = o.replicas ?? runnerReplicas();
  const watchdog = replicas >= 2;
  const standbyRow = `${standbyPrefix(role)}${holder}`;
  const waitingSince = iso();
  let onLost: (c: Pg.Client, why: string) => void = () => {};
  const open = () => leaseClient(pg, db, url, role, log, (c, why) => onLost(c, why));
  let conn: LeaseConn | null = null;
  let standbyBeat = 0, announced = false, lastError = "";
  const k = db.k;
  const leases = "leader_leases" as const;

  // Standby: read the lease until it has expired (or there is none), then take it under the writer lock.
  onLost = (c, why) => {
    if (conn?.client !== c) return;
    conn = null;
    log(`leader: the ${role} lease connection failed while waiting (${why}); opening another`);
    void c.end().catch(() => undefined);
  };
  let epoch = 0;
  /** performance.now() when the winning statement was sent: the lease runs LEASE_MS from no earlier than that. */
  let wonAt = 0;
  for (;;) {
    if (o.signal?.aborted) {
      await conn?.client.end().catch(() => undefined);
      await db.prepare("DELETE FROM settings WHERE key = ?").run(standbyRow).catch(() => undefined);
      return null;
    }
    try {
      conn ??= await open();
      const [cur] = await conn.run(k.selectFrom(leases).select((eb) => [eb(eb.ref("expires_ms"), "<", serverMs()).as("free")]).where("role", "=", role));
      if (!cur || cur.free) {
        // The epoch moves in a write transaction, so every write of an earlier holder committed before it or is fenced. It
        // is at least the server's clock in ms, so it stays above every earlier epoch even when the row was lost or
        // replaced (a database copy) or an earlier version counted epochs elsewhere.
        const sent = performance.now();
        const won = await db.get(k.insertInto(leases).values({ role, holder, epoch: serverMs(), expires_ms: serverMs(leaseMs) })
          .onConflict((oc) => oc.column("role").doUpdateSet((eb) => ({ holder, epoch: sql<number>`GREATEST(${eb.ref(`${leases}.epoch`)} + 1, ${serverMs()})`, expires_ms: serverMs(leaseMs) }))
            .where(`${leases}.expires_ms`, "<", serverMs()))
          .returning("epoch"));
        if (won) {
          epoch = Number(won.epoch);
          wonAt = sent;
          break;
        }
      }
      if (!announced) {
        announced = true;
        log(`leader: another copy leads the ${role}; waiting as a standby`);
        // Outside a deploy's brief overlap, a standby means a second replica runs without the watchdog it needs.
        if (!watchdog) log(`leader: warning: AUTOCRAFT_RUNNER_REPLICAS is ${replicas}, but another copy of the ${role} runs; set it to the number of copies`);
        o.onStandby?.();
      }
      if (Date.now() - standbyBeat >= beatMs) {
        standbyBeat = Date.now();
        await putSetting(db, standbyRow, JSON.stringify({ holder, since: waitingSince, at: iso(), replicas } satisfies StandbyStatus));
      }
      lastError = "";
    } catch (e) {
      const msg = (e as Error).message;
      if (msg !== lastError) log(`leader: cannot read or take the ${role} lease: ${msg}`);
      lastError = msg;
      const c = conn?.client;
      conn = null;
      await c?.end().catch(() => undefined);
    }
    await pause(retryMs, o.signal);
  }

  let current: LeaseConn | null = conn;
  const ac = new AbortController();
  let released = false;
  /**
   * performance.now() when the last successful renewal (or the takeover) was sent: monotonic, and it still counts
   * event-loop stalls. A late answer cannot stretch the watchdog past the lease, which runs from no earlier than that.
   */
  let lastOk = wonAt;
  let check: NodeJS.Timeout | undefined, watch: NodeJS.Timeout | undefined, beat: NodeJS.Timeout | undefined;
  const stopTimers = () => { clearInterval(check); clearInterval(watch); clearInterval(beat); };
  const drop = (c: LeaseConn | null): void => {
    if (c && current === c) current = null;
    void c?.client.end().catch(() => undefined);
  };
  const lose = (why: string): void => {
    if (released || ac.signal.aborted) return;
    stopTimers();
    log(`leader: lost the ${role} lease (${why})`);
    ac.abort(new Error(why));
    drop(current);
  };
  const since = iso();
  const status = (at: string): string => JSON.stringify({ holder, epoch, since, at, replicas, conn: current?.info ?? null } satisfies LeaderStatus);
  const renewal = () => k.updateTable(leases).set({ expires_ms: serverMs(leaseMs) })
    .where("role", "=", role).where("holder", "=", holder).where("epoch", "=", epoch).returning("epoch");

  onLost = (c, why) => {
    if (c !== current?.client) return;
    log(`leader: the ${role} lease connection failed (${why}); renewing on a new one`);
    drop(current);
  };

  /** The renewal that has not answered yet: a hung one must not stack up further renewals. */
  let renewing = false;
  check = setInterval(() => {
    if (renewing || released || ac.signal.aborted) return;
    renewing = true;
    const sent = performance.now();
    void (async () => {
      let c: LeaseConn | null = current;
      try {
        c = current ??= await within(open(), QUERY_MS + CONNECT_MS, "the lease connection");
        const rows = await c.run(renewal());
        if (!rows.length) return lose("another copy took the lease");
        lastOk = Math.max(lastOk, sent);
      } catch (e) {
        if (c === current) drop(c);
        if (!watchdog) log(`leader: the ${role} lease was not renewed: ${(e as Error).message}`);
      } finally {
        renewing = false;
      }
    })();
  }, checkMs);
  // After a stall of the event loop this fires late and sees the whole gap.
  watch = setInterval(() => {
    const gap = performance.now() - lastOk;
    if (gap <= lossMs || !watchdog) return;
    lose(`no successful renewal of the lease for ${Math.round(gap / 1000)} s`);
  }, Math.min(250, checkMs));
  beat = setInterval(() => {
    // Fenced like every write of this process: a refusal means another copy has taken over.
    void (async () => {
      await putSetting(db, leaderKey(role), status(iso()));
      await pruneStandbys(db, role);
      await o.onBeat?.();
    })().catch((e: unknown) => {
      if (isFenced(e)) lose("another copy took over");
      else log(`leader: status of the ${role} not written: ${(e as Error).message}`);
    });
  }, beatMs);
  check.unref();
  watch.unref();
  beat.unref();

  // After the timers, and not awaited: a slow write must not hold up the renewals.
  void (async () => {
    await db.prepare("DELETE FROM settings WHERE key = ?").run(standbyRow);
    await putSetting(db, leaderKey(role), status(since));
  })().catch((e: unknown) => {
    if (isFenced(e)) lose("another copy took over");
    else log(`leader: status of the ${role} not written: ${(e as Error).message}`);
  });
  log(`leader: this copy leads the ${role} (epoch ${epoch})`);

  return {
    role, epoch, holder, lost: ac.signal,
    release: async () => {
      if (released) return;
      released = true;
      stopTimers();
      // Ends the lease now, so a standby takes it at its next read.
      if (!ac.signal.aborted) {
        await db.run(k.updateTable(leases).set({ expires_ms: 0 }).where("role", "=", role).where("holder", "=", holder).where("epoch", "=", epoch))
          .catch((e: unknown) => log(`leader: the ${role} lease was not given up (${(e as Error).message}); it expires on its own`));
      }
      drop(current);
      log(`leader: released the ${role} lease`);
    },
  };
}

/** Removes the rows of standbys that stopped writing them. */
async function pruneStandbys(db: QueryDb, role: LeaderRole): Promise<void> {
  const rows = await db.prepare("SELECT key, value FROM settings WHERE key LIKE ?").all(`${standbyPrefix(role)}%`) as { key: string; value: string }[];
  for (const r of rows) {
    let at = NaN;
    try { at = Date.parse((JSON.parse(r.value) as StandbyStatus).at); } catch { /* removed below */ }
    if (Number.isNaN(at) || Date.now() - at > STANDBY_KEEP_MS) await db.prepare("DELETE FROM settings WHERE key = ? AND value = ?").run(r.key, r.value);
  }
}

/**
 * What the health checks show of a role: its leader's status, the standbys seen within `freshMs`, and `unwatched`, whether
 * a standby runs beside a copy set to one replica (which then runs without the watchdog two copies need); null when no
 * copy was ever elected (SQLite).
 */
export async function leaderStatus(db: Db, role: LeaderRole, freshMs: number, nowMs = Date.now()): Promise<{ leader: LeaderStatus | null; standbys: number; unwatched: boolean } | null> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("settings").select(["key", "value"]).where("key", "like", `${leaderKey(role)}%`));
  const lead = rows.find((r) => r.key === leaderKey(role));
  if (!lead) return null;
  const parse = <T>(v: string | null): T | null => { try { return v ? JSON.parse(v) as T : null; } catch { return null; } };
  const fresh = (s: { at?: unknown } | null): boolean => typeof s?.at === "string" && nowMs - Date.parse(s.at) <= freshMs;
  const live = rows.filter((r) => r.key.startsWith(standbyPrefix(role))).map((r) => parse<StandbyStatus>(r.value)).filter((s) => fresh(s));
  const leader = parse<LeaderStatus>(lead.value);
  const single = (s: { replicas?: unknown } | null): boolean => typeof s?.replicas === "number" && s.replicas < 2;
  return { leader, standbys: live.length, unwatched: live.length > 0 && (single(leader) || live.some(single)) };
}
