// Full-text search over items (title, body) and comments (body) on both backends. SQLite has the FTS5 tables items_fts
// and comments_fts (porter stemming, bm25 ranking); Postgres has the generated tsvector columns items.fts (title weight A,
// body D) and comments.fts (body D) with GIN indexes, english configuration, ranked by ts_rank. Matching follows the same
// parsed query on both; ranking and snippets differ in detail between them.
//
// What a person types is parsed once (`parseSearch`) and bound as one parameter (`searchParam`): an FTS5 query on SQLite,
// to_tsquery text on Postgres. Every word is quoted there, so syntax characters in the input are never operators.
// websearch_to_tsquery is not used: it has no prefix match, which search-as-you-type needs.
import type { Dialect } from "./index.ts";

type D = Dialect | { readonly dialect: Dialect };

const pgOf = (d: D): boolean => (typeof d === "string" ? d : d.dialect) === "postgres";

/** One term: a word or a "quoted phrase", the last word a prefix when `prefix`. */
export interface SearchTerm {
  text: string;
  prefix: boolean;
}

/** A parsed search: every positive term must match, OR joins its neighbours, no negative term may match. */
export interface Search {
  pos: (SearchTerm | "OR")[];
  neg: SearchTerm[];
}

const HAS_WORD = /[\p{L}\p{N}]/u;

/**
 * Parses what a person types, or null when nothing is left to search for. Words must all match; "quoted text" is a
 * phrase; a trailing * matches a prefix; -word excludes; OR between terms means either. `prefixLast` makes the last
 * word a prefix (for search-as-you-type).
 */
export function parseSearch(input: string, prefixLast = false): Search | null {
  const pos: Search["pos"] = [];
  const neg: SearchTerm[] = [];
  const re = /(-?)"([^"]*)"?|(\S+)/g;
  const raw = input.slice(0, 300);
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    if (m[2] !== undefined) {
      if (HAS_WORD.test(m[2])) (m[1] ? neg : pos).push({ text: m[2], prefix: false });
      continue;
    }
    let w = m[3]!;
    if (w === "OR") {
      if (pos.length && pos[pos.length - 1] !== "OR") pos.push("OR");
      continue;
    }
    const isNeg = w.startsWith("-") && w.length > 1;
    if (isNeg) w = w.slice(1);
    const atEnd = m.index + m[0].length === raw.length && !/\s$/.test(raw);
    // a prefix of one or two letters would expand to most of the index
    const prefix = w.endsWith("*") || (prefixLast && atEnd && !isNeg && w.length >= 3);
    w = w.replace(/\*+$/, "");
    if (!HAS_WORD.test(w)) continue;
    (isNeg ? neg : pos).push({ text: w, prefix });
    if (pos.length + neg.length >= 16) break;
  }
  while (pos[pos.length - 1] === "OR") pos.pop();
  if (!pos.length) return null;
  return { pos, neg };
}

/** The FTS5 query for `s`. */
export function fts5Query(s: Search): string {
  const term = (t: SearchTerm) => `"${t.text.replace(/"/g, "")}"${t.prefix ? "*" : ""}`;
  const pos = s.pos.map((t) => (t === "OR" ? "OR" : term(t)));
  return [`(${pos.join(" ")})`, ...s.neg.map((n) => `NOT ${term(n)}`)].join(" ");
}

/** Words joined by a character that is no space: what Postgres's parser may keep as one lexeme (a path, a file or host name, a version). */
const JOINED = /[\p{L}\p{N}][^\p{L}\p{N}\s]+[\p{L}\p{N}]/u;

/**
 * to_tsquery text for `s`: words reduced to letters and digits and quoted, a phrase as `<->`; `weight` limits every lexeme to it.
 * A term with joined words also matches as written, quoted: Postgres parses it as it parsed the stored text, where `src/lib.rs`
 * is one lexeme and none of its words is.
 */
export function tsQueryText(s: Search, weight = ""): string {
  const quoted = (w: string, prefix: boolean): string => `'${w}'${prefix || weight ? `:${prefix ? "*" : ""}${weight}` : ""}`;
  const term = (t: SearchTerm): string => {
    const words = t.text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const lex = words.map((w, i) => quoted(w, t.prefix && i === words.length - 1));
    if (lex.length === 1) return lex[0]!;
    const phrase = `(${lex.join(" <-> ")})`;
    if (!JOINED.test(t.text)) return phrase;
    const raw = t.text.replace(/[\u0000-\u001f]/g, " ").replace(/[\\']/g, (c) => c + c);
    return `(${phrase} | ${quoted(raw, t.prefix)})`;
  };
  // FTS5 joins adjacent terms with AND, which binds tighter than OR.
  const groups: string[][] = [[]];
  for (const t of s.pos) {
    if (t === "OR") groups.push([]);
    else groups[groups.length - 1]!.push(term(t));
  }
  const pos = groups.filter((g) => g.length).map((g) => (g.length > 1 ? `(${g.join(" & ")})` : g[0]!));
  return [`(${pos.join(" | ")})`, ...s.neg.map((n) => `!${term(n)}`)].join(" & ");
}

/** The value for the query parameter of the SQL below. `titleOnly` matches titles only. */
export function searchParam(d: D, s: Search, opts: { titleOnly?: boolean } = {}): string {
  if (pgOf(d)) return tsQueryText(s, opts.titleOnly ? "A" : "");
  return opts.titleOnly ? `title : ${fts5Query(s)}` : fts5Query(s);
}

const tsq = (param: string): string => `to_tsquery('english', ${param})`;

/**
 * `SELECT rowid AS rid[, score] FROM <items matching param>`, every repo (join the items view to scope it). `score` is
 * lower for better matches (SQLite bm25, Postgres -ts_rank), the title weighing ten times the body. `cols` adds to
 * the select list (snippetSql); `tail` follows the WHERE condition (`AND ...`, ORDER BY, LIMIT); order by `rowid`.
 */
export function itemMatchSql(d: D, param: string, opts: { score?: boolean; cols?: string; tail?: string } = {}): string {
  const tail = opts.tail ? ` ${opts.tail}` : "";
  const cols = opts.cols ? `, ${opts.cols}` : "";
  if (pgOf(d)) return `SELECT rowid AS rid${opts.score ? `, -ts_rank(fts, ${tsq(param)}) AS score` : ""}${cols} FROM main.items WHERE fts @@ ${tsq(param)}${tail}`;
  return `SELECT rowid AS rid${opts.score ? ", bm25(items_fts, 10.0, 1.0) AS score" : ""}${cols} FROM items_fts WHERE items_fts MATCH ${param}${tail}`;
}

/**
 * `SELECT <cols>[, score] FROM <comments matching param> c <join>`: `c` is the comment row (main.comments), `join` may
 * join further tables before the condition, `tail` follows it. `score` as in itemMatchSql, times `weight`.
 */
export function commentMatchSql(d: D, param: string, cols: string, opts: { join?: string; score?: number; tail?: string } = {}): string {
  const join = opts.join ? ` ${opts.join}` : "";
  const tail = opts.tail ? ` ${opts.tail}` : "";
  if (pgOf(d)) {
    const score = opts.score !== undefined ? `, -ts_rank(c.fts, ${tsq(param)}) * ${opts.score}` : "";
    return `SELECT ${cols}${score} FROM main.comments c${join} WHERE c.fts @@ ${tsq(param)}${tail}`;
  }
  const score = opts.score !== undefined ? `, bm25(comments_fts) * ${opts.score}` : "";
  return `SELECT ${cols}${score} FROM comments_fts JOIN main.comments c ON c.rowid = comments_fts.rowid${join} WHERE comments_fts MATCH ${param}${tail}`;
}

/** Comment matches best first (after a commentMatchSql condition). */
export const commentRankOrder = (d: D, param: string): string => (pgOf(d) ? `ORDER BY ts_rank(c.fts, ${tsq(param)}) DESC` : "ORDER BY rank");

/**
 * A snippet of the matched `field` around the matches of `param`, marks around each match, about `words` words, `…`
 * where cut. In an itemMatchSql row for title/body (SQLite column 0/1 of items_fts; Postgres reads main.items by rowid),
 * in a commentMatchSql row for "comment".
 */
export function snippetSql(d: D, param: string, field: "title" | "body" | "comment", open: string, close: string, words: number): string {
  if (!pgOf(d)) {
    const [table, col] = field === "comment" ? ["comments_fts", 0] : ["items_fts", field === "title" ? 0 : 1];
    return `snippet(${table}, ${col}, '${open}', '${close}', '…', ${words})`;
  }
  const opts = `'StartSel="${open}", StopSel="${close}", MaxWords=${words}, MinWords=${Math.min(words, 8)}, MaxFragments=1, FragmentDelimiter="…"'`;
  const text = field === "comment" ? "c.body" : field;
  return `ts_headline('english', COALESCE(${text}, ''), ${tsq(param)}, ${opts})`;
}
