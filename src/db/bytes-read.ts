// Which reads return bytes. A fused wave (Db.together on Postgres) carries its rows as JSON, where a bytea column arrives
// as hex text instead of bytes, so the handle refuses such a read in a wave unless it is marked `alone`.
import type { OperationNode, SelectQueryNode } from "kysely";
import { BYTES_COLUMNS } from "./types.ts";

const BYTES = new Set<string>(BYTES_COLUMNS);

// Nodes are read as plain objects: this module must not load kysely.
type N = { readonly kind: string } & Record<string, any>;
/** One FROM entry: the name its columns go by, and its bytes columns under their output names (`of` says where they come from). */
type Source = { name: string; of: (column: string) => string | null; all: () => string | null };

const NONE: Source = { name: "", of: () => null, all: () => null };
/** Functions that return one of their arguments as it is. */
const PASSES = new Set(["coalesce", "max", "min", "nullif"]);

const tableName = (n: N): string => n.table.identifier.name as string;

function tableSource(table: string, name: string): Source {
  const of = (c: string): string | null => (BYTES.has(`${table}.${c}`) ? `${table}.${c}` : null);
  return { name, of, all: () => BYTES_COLUMNS.find((b) => b.startsWith(`${table}.`)) ?? null };
}

/** A subquery or CTE: its outputs that are bytes, by output name. */
function querySource(q: N, name: string, outer: readonly Source[], ctes: readonly Source[]): Source {
  const out = outputs(q, outer, ctes);
  return { name, of: (c) => out.get(c) ?? null, all: () => out.values().next().value ?? null };
}

function sourceOf(n: N, outer: readonly Source[], ctes: readonly Source[], alias?: string): Source {
  if (n.kind === "AliasNode") return sourceOf(n.node, outer, ctes, n.alias?.name ?? alias);
  if (n.kind === "ParensNode") return sourceOf(n.node, outer, ctes, alias);
  if (n.kind === "TableNode") {
    const table = tableName(n);
    const cte = n.table.schema ? undefined : ctes.find((c) => c.name === table);
    return cte ? { ...cte, name: alias ?? table } : tableSource(table, alias ?? table);
  }
  if (n.kind === "SelectQueryNode") return querySource(n, alias ?? "", outer, ctes);
  return { ...NONE, name: alias ?? "" };
}

/** The bytes column an expression returns as it is, or null. Raw SQL with text of its own is taken to transform it. */
function bytesOf(n: N, sources: readonly Source[], ctes: readonly Source[]): string | null {
  switch (n.kind) {
    case "AliasNode": case "ParensNode": return bytesOf(n.node, sources, ctes);
    case "SelectionNode": return bytesOf(n.selection, sources, ctes);
    case "ColumnNode": return first(sources, (s) => s.of(n.column.name));
    case "ReferenceNode": {
      const from = n.table ? sources.filter((s) => s.name === tableName(n.table)) : sources;
      return n.column.kind === "SelectAllNode" ? first(from, (s) => s.all()) : first(from, (s) => s.of(n.column.column.name));
    }
    case "SelectAllNode": return first(sources, (s) => s.all());
    case "FunctionNode": return PASSES.has(String(n.func).toLowerCase()) ? first(n.arguments as N[], (a) => bytesOf(a, sources, ctes)) : null;
    case "CaseNode": return first([...(n.when ?? []).map((w: N) => w.result), n.else].filter(Boolean) as N[], (a) => (a.kind ? bytesOf(a, sources, ctes) : null));
    case "RawNode": return (n.sqlFragments as string[]).every((f) => !f.trim()) ? first(n.parameters as N[], (a) => bytesOf(a, sources, ctes)) : null;
    case "SelectQueryNode": return outputs(n, sources, ctes).values().next().value ?? null;
    default: return null;
  }
}

function first<T>(xs: readonly T[], f: (x: T) => string | null): string | null {
  for (const x of xs) {
    const r = f(x);
    if (r) return r;
  }
  return null;
}

const nameOf = (n: N): string => {
  if (n.kind === "SelectionNode") return nameOf(n.selection);
  if (n.kind === "AliasNode") return n.alias?.name ?? "";
  if (n.kind === "ReferenceNode") return n.column?.column?.name ?? "";
  return n.kind === "ColumnNode" ? n.column.name : "";
};

/** The bytes columns `q` returns, by output name ("*" for those of a select-all). */
function outputs(q: N, outer: readonly Source[], outerCtes: readonly Source[]): Map<string, string> {
  const ctes = [...outerCtes];
  for (const e of (q.with?.expressions ?? []) as N[]) ctes.unshift(querySource(e.expression, e.name.table.table.identifier.name, outer, ctes));
  const out = new Map<string, string>();
  if (q.kind !== "SelectQueryNode") return out;
  const own = [...((q.from?.froms ?? []) as N[]).map((f) => sourceOf(f, outer, ctes)), ...((q.joins ?? []) as N[]).map((j) => sourceOf(j.table, outer, ctes))];
  const sources = [...own, ...outer];
  for (const s of (q.selections ?? []) as N[]) {
    const star = s.selection?.kind === "SelectAllNode" || s.selection?.column?.kind === "SelectAllNode";
    if (star) {
      // Every bytes column of the sources, under its own name.
      const from = s.selection.table ? own.filter((x) => x.name === tableName(s.selection.table)) : own;
      for (const b of BYTES) {
        const c = b.slice(b.indexOf(".") + 1);
        const hit = first(from, (x) => x.of(c));
        if (hit) out.set(c, hit);
      }
      continue;
    }
    const b = bytesOf(s, sources, ctes);
    if (b) out.set(nameOf(s) || "*", b);
  }
  for (const s of (q.setOperations ?? []) as N[]) for (const [c, b] of outputs(s.expression, outer, ctes)) out.set(c, b);
  return out;
}

/** Most statements whose answer is kept: their texts, which the parameters are not part of. */
const CACHE_MAX = 5_000;
const cache = new Map<string, string | null>();

/** The bytes column (`table.column`) among what the read `node` returns, or null; `sql` is its compiled text. */
export function bytesRead(node: SelectQueryNode, sql: string): string | null {
  let r = cache.get(sql);
  if (r === undefined) {
    r = outputs(node as OperationNode as N, [], []).values().next().value ?? null;
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(sql, r);
  }
  return r;
}
