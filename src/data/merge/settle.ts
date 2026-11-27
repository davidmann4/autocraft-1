// Shared by the verification, PR build and screenshot writers: compare-and-set updates keyed by `repo#number@head`.
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import type { HeadRef } from "./types.ts";

export type Param = string | number | null;
export type HeadTable = "verifications" | "pr_builds" | "screenshot_runs";
export type SettleRow = {
  key: HeadRef;
  /** The row changes only while its `state` is one of these. */
  from?: readonly string[];
  /** Further columns that must equal these values. */
  guard?: Record<string, Param>;
  set: Record<string, Param>;
};

export const nowIso = (): string => new Date().toISOString();

export function splitHead(key: HeadRef): { repo: string; number: number; head: string } {
  const at = key.lastIndexOf("@");
  const hash = key.lastIndexOf("#", at);
  return { repo: key.slice(0, hash), number: Number(key.slice(hash + 1, at)), head: key.slice(at + 1) };
}

export const safeJson = (text: string | null | undefined): unknown => {
  try { return text === null || text === undefined ? null : JSON.parse(text); } catch { return null; }
};

/**
 * Sets columns on rows of `table` named by head key, one `UPDATE ... FROM` per distinct (columns, `from`, `guard`) shape and
 * 10,000 rows, and returns the keys that changed. A row whose state or guard no longer holds stays out of the result.
 * `types` gives each set column's JSON type (`text` or `bigint`). Call inside `db.write` when other writes must commit with it.
 */
export async function settleByHead(db: Db, table: HeadTable, types: Record<string, "text" | "bigint">, rows: readonly SettleRow[]): Promise<Set<HeadRef>> {
  const out = new Set<HeadRef>();
  if (rows.length === 0) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const byKey = new Map<HeadRef, SettleRow>();
  for (const r of rows) byKey.set(r.key, r);
  const groups = new Map<string, SettleRow[]>();
  for (const r of byKey.values()) {
    const shape = JSON.stringify([Object.keys(r.set).sort(), [...(r.from ?? [])].sort(), r.from === undefined, Object.entries(r.guard ?? {}).sort()]);
    (groups.get(shape) ?? groups.set(shape, []).get(shape)!).push(r);
  }
  for (const group of groups.values()) {
    const first = group[0]!;
    const cols = Object.keys(first.set).sort();
    const guard = Object.entries(first.guard ?? {});
    for (const chunk of kx.chunks(group)) {
      const v = kx.valuesTable(db, chunk.map((r) => ({ ...splitHead(r.key), ...r.set })),
        { repo: "text", number: "bigint", head: "text", ...Object.fromEntries(cols.map((c) => [c, types[c]!])) }, "v");
      const changed = await q.all(k.updateTable(table).from(v)
        .set((eb: any) => Object.fromEntries(cols.map((c) => [c, eb.ref(`v.${c}`)])))
        .where((eb: any) => eb.and([
          eb(`${table}.repo`, "=", eb.ref("v.repo")), eb(`${table}.number`, "=", eb.ref("v.number")), eb(`${table}.head_sha`, "=", eb.ref("v.head")),
          ...(first.from ? [eb(`${table}.state`, "in", [...first.from])] : []),
          ...guard.map(([c, val]) => (val === null ? eb(`${table}.${c}`, "is", null) : eb(`${table}.${c}`, "=", val))),
        ]))
        .returning([`${table}.repo as repo`, `${table}.number as number`, `${table}.head_sha as head`])) as { repo: string; number: number; head: string }[];
      for (const c of changed) out.add(`${c.repo}#${c.number}@${c.head}`);
    }
  }
  return out;
}
