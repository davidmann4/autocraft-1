// Batched keyed updates that `kx.updateFrom` cannot express: a guard on the stored row, or a set clause that reads it.
import type { Expression, SqlBool } from "kysely";
import type { Db, Param } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";

type Types = Record<string, kx.ElemType>;

/**
 * `UPDATE table SET c = v.c [, extra] FROM (rows) v WHERE table.k = v.k [AND when]`, in chunks. `key` and `set` map column
 * names to their Postgres type; every row carries all of them. `also` adds set clauses that read the stored row
 * (`retries + 1`); `when` is a guard on the stored row and the values (`v.state`); `guard` names value columns that only `when` reads. Returns the rows changed. Call inside `db.write`.
 */
export async function patchRows(
  db: Db, table: string, key: Types, set: Types, rows: readonly Record<string, Param>[],
  o: { also?: (eb: kx.AnyEb) => Record<string, Expression<any>>; when?: (eb: kx.AnyEb) => Expression<SqlBool>; guard?: Types } = {},
): Promise<number> {
  const qdb = queryDb(db);
  let changed = 0;
  for (const part of kx.chunks(rows)) {
    const q = (qdb.k as any).updateTable(table).from(kx.valuesTable(db, part, { ...key, ...set, ...o.guard }, "v"))
      .set((eb: kx.AnyEb) => ({ ...Object.fromEntries(Object.keys(set).map((c) => [c, eb.ref(`v.${c}`)])), ...o.also?.(eb) }))
      .where((eb: kx.AnyEb) => eb.and([...Object.keys(key).map((c) => eb(`${table}.${c}`, "=", eb.ref(`v.${c}`))), ...(o.when ? [o.when(eb)] : [])]));
    changed += (await qdb.run(q)).changes;
  }
  return changed;
}

/** `rows` grouped by the signature `sig(row)`, in first-seen order. */
export function groupBy<T>(rows: readonly T[], sig: (r: T) => string): T[][] {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const s = sig(r);
    (out.get(s) ?? out.set(s, []).get(s)!).push(r);
  }
  return [...out.values()];
}
