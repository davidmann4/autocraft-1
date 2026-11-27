// One compare-and-set patch statement per distinct patch shape, for the workspace and session writers. Internal to the build module.
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";

export type RowPatch = { id: number; /** The row must be in one of these states. */ from?: readonly string[]; set: Record<string, unknown>; /** Columns that must still hold these values (null-safe); the row then has a statement of its own. */ where?: Record<string, string | number | null> };

const isBlob = (v: unknown): boolean => v instanceof Uint8Array;

/**
 * Patches rows by id. Rows with the same columns and the same `from` go in one statement (`UPDATE ... FROM (JSON values)`); a row
 * that sets a blob or has a `where`, or the only row of its shape, has a statement of its own. Returns the ids that matched, so a `from` that no
 * longer holds is seen as a row that did not move. Joins the caller's transaction.
 */
export async function patchRows(db: Db, table: "workspaces" | "workspace_sessions" | "workspace_calls", rows: RowPatch[], numeric: readonly string[]): Promise<Set<number>> {
  const moved = new Set<number>();
  if (!rows.length) return moved;
  const q = queryDb(db);
  const k = q.k as any;
  const groups = new Map<string, RowPatch[]>();
  for (const r of rows) {
    const cols = Object.keys(r.set).filter((c) => r.set[c] !== undefined).sort();
    const key = JSON.stringify([r.from ? [...r.from].sort() : null, cols, r.where || cols.some((c) => isBlob(r.set[c])) ? r.id : null]);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  await db.write(async () => {
    for (const group of groups.values()) {
      const byId = [...new Map(group.map((r) => [r.id, r])).values()];
      const cols = Object.keys(byId[0]!.set).filter((c) => byId[0]!.set[c] !== undefined).sort();
      const from = byId[0]!.from;
      if (!cols.length) continue;
      if (byId.length === 1) {
        const r = byId[0]!;
        const out = await q.all(k.updateTable(`main.${table}`).set(Object.fromEntries(cols.map((c) => [c, r.set[c]])))
          .where("id", "=", r.id).$if(!!from, (b: any) => b.where("state", "in", [...from!]))
          .$if(!!r.where, (b: any) => b.where((eb: any) => eb.and(Object.entries(r.where!).map(([c, v]) => eb(c, v === null ? "is" : "=", v))))).returning("id"));
        for (const o of out as { id: number }[]) moved.add(Number(o.id));
        continue;
      }
      for (const part of kx.chunks(byId, kx.JSON_CHUNK)) {
        const v = kx.valuesTable(db, part.map((r) => ({ id: r.id, ...Object.fromEntries(cols.map((c) => [c, r.set[c] as string | number | null])) })),
          { id: "bigint", ...Object.fromEntries(cols.map((c) => [c, numeric.includes(c) ? "bigint" as const : "text" as const])) }, "v");
        const out = await q.all(k.updateTable(`main.${table}`).from(v)
          .set((eb: any) => Object.fromEntries(cols.map((c) => [c, eb.ref(`v.${c}`)])))
          .where((eb: any) => eb.and([eb(`${table}.id`, "=", eb.ref("v.id")), ...(from ? [eb(`${table}.state`, "in", [...from])] : [])]))
          .returning(`${table}.id as id`));
        for (const o of out as { id: number }[]) moved.add(Number(o.id));
      }
    }
  });
  return moved;
}
