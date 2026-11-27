// Writes of one kind asked for side by side (a pool's calls beginning or ending together) go into the database as one: what is
// asked for while a write is under way joins the next.
import type { Db } from "../db/index.ts";
import { isFenced } from "../db/fence.ts";

/** The event loop's setImmediate as the module found it, so tests that mock timers do not hold a batch back. */
const immediate = globalThis.setImmediate.bind(globalThis);

type Entry<T, R> = { row: T; resolve: (r: R) => void; reject: (e: unknown) => void };

export class WriteBatch<T, R> {
  readonly #write: (db: Db, rows: T[]) => Promise<R[]>;
  readonly #queues = new WeakMap<Db, { waiting: Entry<T, R>[]; running: boolean }>();

  /** `write` stores the rows in one transaction and gives one result per row, in order. */
  constructor(write: (db: Db, rows: T[]) => Promise<R[]>) { this.#write = write; }

  /** Resolves once the row is committed. Inside a transaction it is written at once, as part of it. */
  async add(db: Db, row: T): Promise<R> {
    if (db.inTransaction()) return (await this.#write(db, [row]))[0]!;
    let q = this.#queues.get(db);
    if (!q) this.#queues.set(db, (q = { waiting: [], running: false }));
    const queue = q;
    return await new Promise<R>((resolve, reject) => {
      queue.waiting.push({ row, resolve, reject });
      if (queue.running) return;
      queue.running = true;
      immediate(() => void this.#drain(db, queue));
    });
  }

  async #drain(db: Db, queue: { waiting: Entry<T, R>[]; running: boolean }): Promise<void> {
    while (queue.waiting.length) {
      const entries = queue.waiting.splice(0);
      try {
        const results = await this.#write(db, entries.map((e) => e.row));
        entries.forEach((e, i) => e.resolve(results[i]!));
      } catch (e) {
        // One bad row must not fail the others.
        if (entries.length === 1 || isFenced(e)) for (const x of entries) x.reject(e);
        else for (const x of entries) await this.#write(db, [x.row]).then((r) => x.resolve(r[0]!), x.reject);
      }
    }
    queue.running = false;
  }
}
