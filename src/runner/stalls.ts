// Logs stalls of the runner's event loop. The leader renews its lease on this loop (src/db/leader.ts), and with two or
// more replicas a stall past LOSS_MS loses the lease: each stall over a second is logged with the step the runner was
// in when it began, so a lost lease names what held the loop.
const EVERY_MS = 100;
const MIN_MS = 1_000;

export type Stalls = {
  /** The step the runner enters now; named in the stalls logged from here on. */
  step(name: string): void;
  /** Logs the stall now running out, if any: for a caller about to exit, before the next tick would. */
  check(): void;
  stop(): void;
};

export function watchStalls(log: (line: string) => void, opts: { minMs?: number; everyMs?: number } = {}): Stalls {
  const everyMs = opts.everyMs ?? EVERY_MS, minMs = opts.minMs ?? MIN_MS;
  let step = "startup";
  let last = performance.now();
  const check = (): void => {
    const now = performance.now();
    const stalled = now - last - everyMs;
    last = now;
    if (stalled >= minMs) log(`the event loop was blocked for ${(stalled / 1000).toFixed(1)} s (during ${step})`);
  };
  const timer = setInterval(check, everyMs);
  timer.unref();
  return {
    step: (name) => void (step = name),
    check,
    stop: () => clearInterval(timer),
  };
}
