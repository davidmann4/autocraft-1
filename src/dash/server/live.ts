// Server-sent events for GET /api/live. One watcher reads the `change_seq` markers
// (src/live.ts) and tells every connected browser which topics changed. The stream
// carries topic names and counters only, never data: browsers refetch through the API.
import type { ServerResponse } from "node:http";
import { exclusive } from "../../async-seq.ts";
import { refreshReadIdentity } from "../../github/read.ts";
import type { Db } from "../../db/index.ts";

export type LiveOptions = {
  pollMs?: number;       // how often the markers are read
  heartbeatMs?: number;  // idle streams are dropped by proxies after 100 s
  maxClients?: number;
  maxPerSession?: number;  // the oldest stream of a session is closed when it opens more
  stallMs?: number;        // a client whose socket stays backed up this long is dropped
};

// `greeted`: the hello frame went out; changes go only to greeted clients, so none arrives before the hello.
type Client = { res: ServerResponse; alive: () => Promise<boolean>; session: string; stalled?: NodeJS.Timeout; greeted?: boolean };

export class LiveHub {
  private clients = new Set<Client>();
  private last: Record<string, number> = {};
  private timer?: NodeJS.Timeout;
  private beat?: NodeJS.Timeout;
  // Passes never overlap: two checks at once could set `last` back to the older markers and announce a change twice.
  private checks = exclusive(() => this.check().catch((e: unknown) => console.error(`live: ${(e as Error).message}`)));
  private beats = exclusive(() => this.heartbeat().catch((e: unknown) => console.error(`live heartbeat: ${(e as Error).message}`)));
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  private readonly maxClients: number;
  private readonly maxPerSession: number;
  private readonly stallMs: number;

  private readonly db: Db;

  constructor(db: Db, o: LiveOptions = {}) {
    this.db = db;
    this.pollMs = o.pollMs ?? 500;
    this.heartbeatMs = o.heartbeatMs ?? 25_000;
    this.maxClients = o.maxClients ?? 200;
    this.maxPerSession = o.maxPerSession ?? 32;
    this.stallMs = o.stallMs ?? 5000;
  }

  get size(): number {
    return this.clients.size;
  }

  get full(): boolean {
    return this.clients.size >= this.maxClients;
  }

  /** Takes over `res` (headers already written). `alive` tells whether the session still exists. */
  async add(res: ServerResponse, alive: () => Promise<boolean>, session = ""): Promise<void> {
    const c: Client = { res, alive, session };
    const mine = [...this.clients].filter((x) => x.session === session);
    for (const old of mine.slice(0, Math.max(0, mine.length + 1 - this.maxPerSession))) {
      old.res.end();
      this.remove(old);
    }
    this.clients.add(c);
    if (this.clients.size === 1) await this.start();
    const seqs = await this.read();
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ seqs })}\n\n`);
    c.greeted = true;
    res.on("close", () => this.remove(c));
  }

  /** Checks the markers now, for the answer to a write the dashboard just handled. */
  async poke(): Promise<void> {
    if (this.clients.size) await this.checks.run();
  }

  close(): void {
    for (const c of this.clients) c.res.end();
    this.clients.clear();
    this.stop();
  }

  /** The markers after a check pass, which announces what changed since the last one. */
  private async read(): Promise<Record<string, number>> {
    await this.checks.run();
    return this.last;
  }

  private remove(c: Client): void {
    clearTimeout(c.stalled);
    this.clients.delete(c);
    if (!this.clients.size) this.stop();
  }

  private async start(): Promise<void> {
    await this.read();
    await this.identity(this.last);
    this.timer = setInterval(() => void this.checks.skip(), this.pollMs);
    this.beat = setInterval(() => void this.beats.skip(), this.heartbeatMs);
    this.timer.unref();
    this.beat.unref();
  }

  private stop(): void {
    clearInterval(this.timer);
    clearInterval(this.beat);
    this.timer = this.beat = undefined;
  }

  private async check(): Promise<void> {
    let now: Record<string, number>;
    try {
      now = await this.db.seqs();
    } catch (e) {
      console.error(`live: ${(e as Error).message}`);
      return;
    }
    const topics = Object.keys(now).filter((t) => now[t] !== this.last[t]);
    this.last = now;
    if (!topics.length) return;
    const seqs: Record<string, number> = {};
    for (const t of topics) seqs[t] = now[t]!;
    this.send(`event: change\ndata: ${JSON.stringify({ topics, seqs })}\n\n`);
    if (topics.includes("settings")) await this.identity(now);
  }

  /** The GitHub read identity this process holds follows the `settings` counter. */
  private async identity(seqs: Record<string, number>): Promise<void> {
    try {
      await refreshReadIdentity(this.db, seqs.settings);
    } catch (e) {
      console.error(`live: GitHub identity not refreshed: ${(e as Error).message}`);
    }
  }

  private async heartbeat(): Promise<void> {
    for (const c of this.clients) if (!await c.alive()) { c.res.end(); this.remove(c); }
    this.send(": hb\n\n");
  }

  private send(frame: string): void {
    for (const c of this.clients) {
      if (!c.greeted || c.res.write(frame) || c.stalled) continue;
      // Backed up: wait for 'drain', and drop the client when it does not come.
      const drop = () => { c.res.destroy(); this.remove(c); };
      c.stalled = setTimeout(drop, this.stallMs);
      c.stalled.unref();
      c.res.once("drain", () => { clearTimeout(c.stalled); c.stalled = undefined; });
    }
  }
}
