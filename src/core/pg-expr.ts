// Postgres forms of the SQLite fragments the change-log and live-topic registries are written in (src/db/plan-inputs.ts,
// src/live.ts), for the Postgres triggers (src/db/pg-triggers.ts).

/** A stored JSON text `x` when it is an array, else '[]' (Postgres; CASE keeps the cast from running on text that is not JSON). */
export const pgJsonArray = (x: string): string => `COALESCE(CASE WHEN json_valid(${x}) THEN CASE WHEN json_typeof(${x}::json) = 'array' THEN ${x}::json END END, '[]'::json)`;

/** Replaces each `CAST(x AS INTEGER)` with `ac_int(x)`, SQLite's text-to-integer rule on Postgres (a numeric prefix, else 0). */
function castInts(sql: string): string {
  let out = "";
  let i = 0;
  for (let at = sql.indexOf("CAST(", i); at >= 0; at = sql.indexOf("CAST(", i)) {
    let depth = 0, end = at + 4;
    for (; end < sql.length; end++) {
      if (sql[end] === "(") depth++;
      else if (sql[end] === ")" && --depth === 0) break;
    }
    const inner = sql.slice(at + 5, end);
    const m = /^([\s\S]*)\s+AS\s+INTEGER$/i.exec(inner);
    if (!m) throw new Error(`no Postgres form for the cast in: ${sql}`);
    out += `${sql.slice(i, at)}ac_int(${castInts(m[1]!)})`;
    i = end + 1;
  }
  return out + sql.slice(i);
}

/**
 * A SQLite condition or subquery of the registries in Postgres syntax: IS NOT between values → IS DISTINCT FROM, no unary +
 * on columns, integer casts through ac_int. Throws on SQLite's JSON functions and GLOB, which need a written Postgres form
 * (PlanInput.pg).
 */
export function pgExpr(sql: string): string {
  if (sql === "1") return "true";
  const s = castInts(sql.replace(/\bIS NOT (?!NULL\b|DISTINCT\b)/g, "IS DISTINCT FROM ").replace(/\+(?=[a-z_]\w*\.)/g, ""));
  if (/\b(json_each|json_extract|json_type|json_array_length|json_tree|json_group_\w+)\(|\bGLOB\b|\bsqlite_|\btypeof\(/i.test(s)) throw new Error(`no Postgres form for: ${sql}`);
  return s;
}

