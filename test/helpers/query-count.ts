// Query-count tests: a unit of work must issue the same number of statements whatever its size, apart from a fixed
// number per external effect (conventions 2.7: a guard read and a write around each GitHub write, model call or launch).
import assert from "node:assert/strict";
import type { Db, DbStats } from "../../src/db/index.ts";

/** One size of a unit: the handle it runs on, the work to meter, and what to close afterwards. */
export interface FlatUnit {
  db: Db;
  run(): Promise<unknown>;
  close?(): Promise<void>;
}

export interface FlatOptions {
  /** Statements each effect may add (default 2: the guard read before it and the write after it). */
  perEffect?: number;
}

/**
 * Runs `unit(small)` and `unit(large)` inside `db.meter` and asserts that the large run's statements, less `perEffect`
 * for each effect it counted, are no more than the small run's on the same terms. `unit(size)` prepares its data outside
 * the meter and should give both sizes the same starting state (a fresh database, or the same warm caches). Returns the
 * two counts for further relations.
 */
export async function expectFlat(unit: (size: number) => Promise<FlatUnit>, small: number, large: number, opts: FlatOptions = {}): Promise<{ small: DbStats; large: DbStats }> {
  assert.ok(large > small, `expectFlat: the large size (${large}) must exceed the small one (${small})`);
  const perEffect = opts.perEffect ?? 2;
  const measure = async (size: number): Promise<DbStats & { texts: Map<string, number> }> => {
    const u = await unit(size);
    const texts = new Map<string, number>();
    const stop = u.db.observe((e) => {
      if (e.kind !== "query") return;
      const text = `${e.sql.replace(/\s+/g, " ").replace(/\((?:(?:\?|\$\d+), )*(?:\?|\$\d+)\)/g, "(..)").replace(/\(\.\.\)(?:, \(\.\.\))+/g, "(..)").slice(0, 160)} <- ${e.site.replace(/\(?file:\S*\/(?=src\/)/, "")}`;
      texts.set(text, (texts.get(text) ?? 0) + 1);
    });
    try {
      return { ...(await u.db.meter(() => u.run())).stats, texts };
    } finally {
      stop();
      await u.close?.();
    }
  };
  const { texts: before, ...a } = await measure(small);
  const { texts: after, ...b } = await measure(large);
  const grown = (): string => [...after].map(([t, n]) => [t, n - (before.get(t) ?? 0)] as const).filter(([, d]) => d > 0).sort((x, y) => y[1] - x[1])
    .slice(0, 12).map(([t, d]) => `\n  +${d} ${t}`).join("");
  const net = (s: DbStats): number => s.statements - perEffect * s.effects;
  assert.ok(
    net(b) <= net(a),
    `statements grow with size: ${b.statements} at size ${large} (${b.effects} effects) against ${a.statements} at size ${small} (${a.effects} effects), allowing ${perEffect} per effect; sent more often:${grown()}`,
  );
  return { small: a, large: b };
}
