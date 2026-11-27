// Request and reply with a worker thread, for synchronous work (native model runs, node:sqlite queries) that must not
// hold the calling thread's event loop. One worker per ThreadCall, started on the first call and kept; calls queue in it
// one at a time. The worker keeps the process alive only while a call waits for its reply.
import { parentPort, Worker } from "node:worker_threads";

type Reply<R> = { n: number; ok: true; value: R } | { n: number; ok: false; error: string };
type Waiting<R> = { ok: (v: R) => void; fail: (e: Error) => void; timer?: NodeJS.Timeout };
/** A worker with the calls it still owes a reply, so a stopped worker fails only its own calls, never its replacement's. */
type Running<R> = { w: Worker; pending: Map<number, Waiting<R>> };

export class ThreadCall<Q, R> {
  private current: Running<R> | null = null;
  private seq = 0;
  private readonly url: URL;
  private readonly what: string;
  private readonly workerData: unknown;
  private readonly timeoutMs: number | undefined;

  /**
   * `what` names the worker in errors. With `timeoutMs`, a call without a reply by then fails, and the worker is replaced:
   * one stuck call would otherwise hold every call queued behind it.
   */
  constructor(url: URL, what: string, workerData?: unknown, opts: { timeoutMs?: number } = {}) {
    this.url = url;
    this.what = what;
    this.workerData = workerData;
    this.timeoutMs = opts.timeoutMs;
  }

  call(q: Q): Promise<R> {
    return new Promise((ok, fail) => {
      const run = this.spawn();
      const n = ++this.seq;
      if (!run.pending.size) run.w.ref();
      const p: Waiting<R> = { ok, fail };
      if (this.timeoutMs !== undefined) {
        const ms = this.timeoutMs;
        p.timer = setTimeout(() => this.stop(run, new Error(`the ${this.what} call got no reply within ${ms / 1000} s`)), ms);
      }
      run.pending.set(n, p);
      run.w.postMessage({ n, q });
    });
  }

  /** Stops the worker; calls still waiting fail. */
  async close(): Promise<void> {
    const run = this.current;
    this.current = null;
    await run?.w.terminate();
  }

  /** Fails the worker's waiting calls with `e` and stops it. */
  private stop(run: Running<R>, e: Error): void {
    this.settleAll(run, e);
    void run.w.terminate();
  }

  private settleAll(run: Running<R>, e: Error): void {
    if (this.current === run) this.current = null;
    for (const p of run.pending.values()) {
      clearTimeout(p.timer);
      p.fail(e);
    }
    run.pending.clear();
  }

  private spawn(): Running<R> {
    if (this.current) return this.current;
    const run: Running<R> = { w: new Worker(this.url, { workerData: this.workerData }), pending: new Map() };
    run.w.on("message", (m: Reply<R>) => {
      const p = run.pending.get(m.n);
      run.pending.delete(m.n);
      if (!run.pending.size) run.w.unref();
      if (!p) return;
      clearTimeout(p.timer);
      if (m.ok) p.ok(m.value);
      else p.fail(new Error(m.error));
    });
    run.w.on("error", (e: Error) => this.settleAll(run, e));
    run.w.on("exit", (code) => this.settleAll(run, new Error(`the ${this.what} worker stopped (exit code ${code})`)));
    run.w.unref();
    return (this.current = run);
  }
}

/** The worker side: answers each call with `handle`'s result or its error message, one call at a time. */
export function serveCalls<Q, R>(handle: (q: Q) => R | Promise<R>): void {
  const port = parentPort;
  if (!port) throw new Error("serveCalls runs in a worker thread");
  let queue: Promise<void> = Promise.resolve();
  const answer = async (m: { n: number; q: Q }): Promise<void> => {
    try {
      port.postMessage({ n: m.n, ok: true, value: await handle(m.q) } satisfies Reply<R>);
    } catch (e) {
      port.postMessage({ n: m.n, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies Reply<R>);
    }
  };
  port.on("message", (m: { n: number; q: Q }) => {
    // The error reply itself can throw (a message that cannot be cloned); the next call still runs.
    queue = queue.then(() => answer(m)).catch(() => undefined);
  });
}
