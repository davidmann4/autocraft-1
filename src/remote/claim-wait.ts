// Long-polling claims (protocol 4): a claim that finds nothing to take and has no reason to give waits up to its hold time
// for a call. Calls are queued by job processes, not by the dashboard, so a waiting claim cannot be woken in-process: while
// any claim waits, one timer reads the `remote-queue` topic's change counter (src/live.ts) and, when it moved, tries the
// waiting claims one at a time, oldest first. Each claim is also tried in full every RETRY_MS and once at its deadline.
import { isBusy } from "../db.ts";
import type { ClaimReply } from "./protocol.ts";

export type EmptyReply = Extract<ClaimReply, { lease: null }>;
import { scaled, scaledS } from "./time-scale.ts";
import type { Db } from "../db/index.ts";

/** The longest a claim is held, in seconds, whatever its `wait` asks. */
export const HOLD_MAX_S = 25;
/** How often the timer reads the topic counter while claims wait. */
export const TICK_MS = scaled(500);
/** How often a waiting claim is tried in full (cool-off, max calls at once, tiers, repos) even when the queue did not change. */
export const RETRY_MS = scaled(5_000);

/** The longest one pass of the timer runs before it lets other requests be served. */
const YIELD_MS = 5;

/** How long a claim asking for `wait` seconds is held, in ms; 0 when it asks for none. */
export const holdMs = (wait: number | undefined): number => (wait && wait > 0 ? scaled(Math.min(wait, HOLD_MAX_S) * 1000) : 0);

/**
 * One try of a claim: a reply to send now, or null when there is nothing to take and no reason to give. `quick`: the queue
 * changed, so try only if the claim's list of candidates is not empty. `live`: whether a client still waits for the reply,
 * asked in the transaction that leases a call, just before the lease is written; true means the try's reply is the claim's
 * answer, so a held claim is no longer answered by its client leaving or by shutdown.
 */
export type ClaimTry = (nowMs: number, opts: { quick: boolean; live: () => boolean }) => Promise<ClaimReply | null>;

/** The claim of one request id, held for every request that waits for it: gone once all of them closed their connection. */
export class Ticket {
  #open = new Set<AbortSignal>();
  #gone = false;
  /** Called once when the last request leaves before the claim is answered. */
  onGone: (() => void) | null = null;
  constructor(signal: AbortSignal) {
    if (signal.aborted) this.#gone = true;
    else this.attach(signal);
  }
  get gone(): boolean { return this.#gone; }
  /** Another request with the same request id waits for this claim's reply. */
  attach(signal: AbortSignal): void {
    if (this.#gone || signal.aborted) return;
    this.#open.add(signal);
    signal.addEventListener("abort", () => {
      this.#open.delete(signal);
      if (this.#open.size || this.#gone) return;
      this.#gone = true;
      this.onGone?.();
    }, { once: true });
  }
}

type Waiter = {
  ticket: Ticket;
  deadline: number;
  nextTry: number;
  /** The topic counter at this claim's last try; null before its first try in the wait. */
  seq: number | null;
  from: number;
  attempt: ClaimTry;
  /** Records the claim as an idle helper's (idle_claim_at). */
  idle: (nowMs: number) => Promise<void>;
  /** The empty reply; `held` when it ends a wait that ran to its deadline. */
  empty: (nowMs: number, held: boolean) => Promise<EmptyReply>;
  /** A reason outside the try to answer at once (a write permission GitHub could not confirm). */
  blocked: () => boolean;
  resolve: (r: ClaimReply) => void;
  reject: (e: unknown) => void;
  done: boolean;
  /** The client leaving or shutdown answered the claim (the reply may still be on its way): a try in flight leases nothing. */
  answered: boolean;
  /**
   * A try passed its `live` check and may be writing a lease: the client leaving or shutdown leaves the answer to the try,
   * so no lease goes out with no one told of it.
   */
  leasing: boolean;
};

/** How long each held reply waited, for the `X-Held-Ms` header. */
const held = new WeakMap<ClaimReply, number>();
export const heldMsOf = (r: ClaimReply): number => held.get(r) ?? 0;

/** The waiting claims of one dashboard process. */
export class ClaimWaits {
  #db: Db;
  #tickMs: number;
  #retryMs: number;
  #waiters: Waiter[] = [];
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #closed = false;

  /** `db`: the helper routes' connection (short busy timeout); a busy database skips a tick. */
  constructor(db: Db, opts: { tickMs?: number; retryMs?: number } = {}) {
    this.#db = db;
    this.#tickMs = opts.tickMs ?? TICK_MS;
    this.#retryMs = opts.retryMs ?? RETRY_MS;
  }

  /** Shutting down: new claims are answered at once. */
  get closed(): boolean { return this.#closed; }
  get size(): number { return this.#waiters.length; }

  /** Holds a claim whose first try found nothing until a try finds something, its client leaves, or `deadline`. */
  hold(ticket: Ticket, deadline: number, w: Pick<Waiter, "attempt" | "idle" | "empty" | "blocked">): Promise<ClaimReply> {
    return new Promise<ClaimReply>((resolve, reject) => {
      const now = Date.now();
      const waiter: Waiter = { ...w, ticket, deadline, nextTry: now + this.#retryMs, seq: null, from: now, resolve, reject, done: false, answered: false, leasing: false };
      const prev = ticket.onGone;
      ticket.onGone = () => {
        if (!waiter.done && !waiter.answered && !waiter.leasing) {
          waiter.answered = true;
          void waiter.empty(Date.now(), false).then((r) => this.#settle(waiter, r), (e: unknown) => this.#settle(waiter, null, e));
        }
        prev?.();
      };
      this.#waiters.push(waiter);
      this.#timer ??= setInterval(() => void this.#tick(), this.#tickMs);
      this.#timer.unref();
    });
  }

  /** Answers every held claim with an empty reply that asks for a retry in 1 to 5 s (spread, so a restart is not hit at once), and stops holding. */
  close(): void {
    this.#closed = true;
    const now = Date.now();
    for (const w of [...this.#waiters]) {
      if (w.done || w.answered || w.leasing) continue;
      w.answered = true;
      void this.#closing(w, now).then((r) => this.#settle(w, r), (e: unknown) => this.#settle(w, null, e));
    }
  }

  async #closing(w: Waiter, now: number): Promise<ClaimReply> {
    return { ...await w.empty(now, false), retryAfter: scaledS(1 + Math.floor(Math.random() * 5)) };
  }

  #settle(w: Waiter, r: ClaimReply | null, err?: unknown): void {
    if (w.done) return;
    w.done = true;
    const i = this.#waiters.indexOf(w);
    if (i >= 0) this.#waiters.splice(i, 1);
    if (!this.#waiters.length && this.#timer) { clearInterval(this.#timer); this.#timer = null; }
    if (r) { held.set(r, Date.now() - w.from); w.resolve(r); } else w.reject(err);
  }

  /** One pass: tries, one at a time, the claims whose queue changed, whose full retry is due, or whose deadline passed. */
  async #tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      let seq: number;
      try {
        seq = (await this.#db.seqs(["remote-queue"]))["remote-queue"] ?? 0;
      } catch (e) {
        if (isBusy(e)) return;
        throw e;
      }
      let slice = performance.now();
      for (const w of [...this.#waiters]) {
        // Requests that arrived meanwhile are served between tries, so a pass over many held claims does not stall them.
        if (performance.now() - slice >= YIELD_MS) {
          await new Promise<void>((r) => setImmediate(r));
          slice = performance.now();
        }
        if (w.done || w.answered) continue;
        const now = Date.now();
        const final = now >= w.deadline, full = final || now >= w.nextTry;
        if (!full && w.seq === seq) continue;
        w.seq = seq;
        if (full) w.nextTry = now + this.#retryMs;
        try {
          // A claim whose client left, or that shutdown or a pass answered meanwhile, must not lease the call it found.
          const live = (): boolean => {
            if (w.done || w.answered || w.ticket.gone || this.#closed) return false;
            w.leasing = true;
            return true;
          };
          let r: ClaimReply | null;
          try {
            r = await w.attempt(now, { quick: !full, live });
          } finally {
            w.leasing = false;
          }
          if (w.done || w.answered) continue;
          if (r) this.#settle(w, r);
          // Shutdown or the client leaving while the try was leasing, which leased nothing, gets the answer it left to the try.
          else if (this.#closed) this.#settle(w, await this.#closing(w, now));
          else if (w.ticket.gone || w.blocked()) this.#settle(w, await w.empty(now, false));
          else if (final) {
            await w.idle(now);
            this.#settle(w, await w.empty(now, true));
          }
        } catch (e) {
          if (w.done || w.answered) continue;
          // A busy database: the claim keeps waiting and is tried again, unless this was its last try.
          if (!isBusy(e) || final) this.#settle(w, null, e);
          // Shutdown or the client leaving while the try was leasing gets the answer it left to the try, not a wait for the next retry.
          else if (this.#closed) await this.#closing(w, now).then((r) => this.#settle(w, r), (err: unknown) => this.#settle(w, null, err));
          else if (w.ticket.gone) await w.empty(now, false).then((r) => this.#settle(w, r), (err: unknown) => this.#settle(w, null, err));
        }
      }
    } catch (e) {
      console.error(`claim waits: ${(e as Error).stack ?? e}`);
    } finally {
      this.#running = false;
    }
  }
}
