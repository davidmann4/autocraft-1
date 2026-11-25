// Translates the SQLite schema (src/schema.sql plus the added columns and indexes in src/db.ts) into the Postgres
// schema committed as src/schema.pg.sql. `node scripts/gen-pg-schema.ts` writes the file and `--check` fails when it is
// stale. The translator accepts only the constructs listed here: anything else throws with the statement, so a new
// construct in schema.sql gets a deliberate translation instead of a silent wrong one.
//
// Rules (docs: the Postgres plan's portability section):
// - INTEGER PRIMARY KEY (with or without AUTOINCREMENT) on a rowid table → bigint identity. Identity sequences start at 1:
//   the data copy sets each one past the copied keys (setval) before the pipeline writes.
// - A rowid table with no INTEGER PRIMARY KEY gets an identity column `rowid` (unique), since code orders by and
//   addresses rows by rowid. WITHOUT ROWID tables get nothing.
// - INTEGER → bigint, REAL → double precision, BLOB → bytea, TEXT → text COLLATE "C", TEXT COLLATE NOCASE → citext COLLATE "C"
//   (citext folds case in its collation: "C" folds ASCII only and then orders by code point, as SQLite NOCASE does).
//   JSON stays text. CHECK constraints and literal defaults are kept.
// - Added columns → ADD COLUMN IF NOT EXISTS. Dropped columns are left out of the tables.
// - FTS5 external-content tables → a stored generated tsvector column `fts` on the base table (title weight A, body D)
//   with a GIN index named after the FTS table.
// - Triggers are translated by hand (HAND_TRIGGERS), keyed by name and pinned to a hash of their SQLite text.
// - A compat function pack (instr, julianday, json_valid, group_concat) comes first.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ADDED_COLUMNS, ADDED_INDEXES, DROPPED_COLUMNS } from "../db.ts";

export const PG_DIALECT = "postgres";

// Postgres keywords that cannot be column names unquoted (pg_get_keywords() catcode R and T, Postgres 18).
const RESERVED = new Set(`all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate
  collation column concurrently constraint create cross current_catalog current_date current_role current_schema current_time
  current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign freeze from full
  grant group having ilike in initially inner intersect into is isnull join lateral leading left like limit localtime
  localtimestamp natural not notnull null offset on only or order outer overlaps placing primary references returning right
  select session_user similar some symmetric system_user table tablesample then to trailing true union unique user using
  variadic verbose when where window with`.split(/\s+/));

// Columns whose SQLite values are not text even though the column says TEXT (gzip bytes since src/agents/runs.ts packText).
export const TYPE_OVERRIDES: Record<string, string> = {
  "agent_run_texts.prompt": "bytea",
  "agent_run_texts.output": "bytea",
};

// The one tokenizer configuration the FTS5 tables use, and the Postgres text search configuration standing in for it.
// Porter stemming → the english snowball stemmer; remove_diacritics has no immutable equivalent (unaccent is not), so
// accents are not folded on Postgres.
const FTS_TOKENIZE = "'porter unicode61 remove_diacritics 2'";
const FTS_WEIGHTS: Record<string, string> = { title: "A", body: "D" };

export const COMPAT_SQL = `-- Compat functions: SQLite built-ins the queries use, with SQLite's results.
-- char() has no equivalent: CHAR is a Postgres keyword, so no function can be called char(...); queries use a dialect helper.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE OR REPLACE FUNCTION instr(s text, sub text) RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURN strpos(s, sub);
-- ISO times without a zone, or with Z, are UTC as in SQLite; text that is not a time gives NULL.
CREATE OR REPLACE FUNCTION julianday(t text) RETURNS double precision LANGUAGE sql STABLE PARALLEL SAFE
  RETURN CASE WHEN pg_input_is_valid(t, 'timestamp') THEN extract(epoch FROM t::timestamp)::double precision / 86400 + 2440587.5 END;
CREATE OR REPLACE FUNCTION json_valid(t text) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURN t IS JSON;
CREATE OR REPLACE FUNCTION group_concat_step(acc text, v anyelement, sep text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT CASE WHEN v IS NULL THEN acc WHEN acc IS NULL THEN v::text ELSE acc || sep || v::text END $$;
CREATE OR REPLACE FUNCTION group_concat_step(acc text, v anyelement) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT CASE WHEN v IS NULL THEN acc WHEN acc IS NULL THEN v::text ELSE acc || ',' || v::text END $$;
CREATE OR REPLACE AGGREGATE group_concat(anyelement) (SFUNC = group_concat_step, STYPE = text, PARALLEL = SAFE);
CREATE OR REPLACE AGGREGATE group_concat(anyelement, text) (SFUNC = group_concat_step, STYPE = text, PARALLEL = SAFE);`;

type HandTrigger = {
  /** First 16 hex digits of the SHA-256 of the SQLite statement's tokens joined by spaces (comments dropped). */
  source: string;
  /** The Postgres statements, or a reason the trigger has no Postgres counterpart. */
  pg: string | { none: string };
};

const fn = (name: string, body: string, ret = "NULL") =>
  `CREATE OR REPLACE FUNCTION trg_${name}() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n${body}\n  RETURN ${ret};\nEND $$;`;
const ever = (name: string, table: string) => `${fn(name, `  INSERT INTO ever_tracked_repos (name)
    VALUES (CASE WHEN NEW.repo LIKE '(security):%' THEN substr(NEW.repo, 12) ELSE NEW.repo END) ON CONFLICT DO NOTHING;`)}
CREATE OR REPLACE TRIGGER ${name} AFTER INSERT ON ${table} FOR EACH ROW WHEN (NEW.repo IS NOT NULL) EXECUTE FUNCTION trg_${name}();`;
const FTS_NONE = { none: "the generated fts column keeps the search vector current" };
// item_plans_rev moves once per writing transaction, at its first write to item_plans: the row stays locked to commit,
// so a read later in the same transaction sees the moved counter (src/core/plan-cache.ts keeps that value).
const planRev = (name: string, op: string) => `CREATE OR REPLACE TRIGGER ${name} AFTER ${op} ON item_plans FOR EACH ROW EXECUTE FUNCTION trg_item_plans_rev();`;
const PLAN_REV_FN = fn("item_plans_rev", `  IF current_setting('autocraft.item_plans_rev', true) IS DISTINCT FROM '1' THEN
    PERFORM set_config('autocraft.item_plans_rev', '1', true);
    UPDATE item_plans_rev SET rev = rev + 1;
  END IF;`);
// The items a batch decision names: objects with a text repo and an integer number (SQLite: typeof() = 'integer').
const DECISION_ITEMS_INSERT = `    INSERT INTO decision_items (repo, number, decision_id)
      SELECT j ->> 'repo', (j ->> 'number')::bigint, NEW.id FROM json_array_elements(NEW.items::json) j
      WHERE json_typeof(j) = 'object' AND json_typeof(j -> 'repo') = 'string' AND json_typeof(j -> 'number') = 'number'
        AND (j ->> 'number') ~ '^-?[0-9]+$'
      ON CONFLICT DO NOTHING;`;
// CASE, not AND: Postgres may evaluate AND operands in any order, and the cast must never see invalid JSON. The
// parentheses keep plpgsql's IF from ending the condition at the CASE's THEN.
const DECISION_ITEMS_WHEN = "NEW.number IS NULL AND (CASE WHEN json_valid(NEW.items) THEN json_typeof(NEW.items::json) = 'array' ELSE false END)";

// One function for the three SQLite triggers: an UPDATE that keeps the key marks it once (ON CONFLICT cannot touch a row
// twice in one statement); a marked item is worked out again whatever the count.
const SETTLED_MARK = (who: string) => `INSERT INTO item_settled_dirty (run_id, repo, number) VALUES (${who}.run_id, ${who}.repo, ${who}.number)
      ON CONFLICT (run_id, repo, number) DO UPDATE SET n = item_settled_dirty.n + 1;`;
const SETTLED_FN = fn("classifications_settled", `  IF TG_OP <> 'DELETE' THEN
    ${SETTLED_MARK("NEW")}
  END IF;
  IF TG_OP = 'DELETE' THEN
    ${SETTLED_MARK("OLD")}
  ELSIF TG_OP = 'UPDATE' THEN
    IF (OLD.run_id, OLD.repo, OLD.number) IS DISTINCT FROM (NEW.run_id, NEW.repo, NEW.number) THEN
      ${SETTLED_MARK("OLD")}
    END IF;
  END IF;`);
const settled = (name: string, op: string) => `CREATE OR REPLACE TRIGGER ${name} AFTER ${op} ON classifications FOR EACH ROW EXECUTE FUNCTION trg_classifications_settled();`;

export const HAND_TRIGGERS: Record<string, HandTrigger> = {
  classifications_settled_i: { source: "c1d5f1f2e66486a2", pg: `${SETTLED_FN}\n${settled("classifications_settled_i", "INSERT")}` },
  classifications_settled_u: { source: "1f5e5a7298e8163f", pg: settled("classifications_settled_u", "UPDATE") },
  classifications_settled_d: { source: "ec2a4d0f1d61aa9a", pg: settled("classifications_settled_d", "DELETE") },
  stages_latest: {
    source: "8a5df492d0eae433",
    pg: `${fn("stages_latest", `  INSERT INTO item_stage (repo, number, stage, at, reviewed)
    VALUES (NEW.repo, NEW.number, NEW.stage, NEW.at, CASE WHEN NEW.stage = 'reviewed' THEN 1 ELSE 0 END)
    ON CONFLICT (repo, number) DO UPDATE SET
      stage = CASE WHEN excluded.at >= item_stage.at THEN excluded.stage ELSE item_stage.stage END,
      at = CASE WHEN excluded.at >= item_stage.at THEN excluded.at ELSE item_stage.at END,
      reviewed = CASE WHEN item_stage.reviewed <> 0 OR excluded.reviewed <> 0 THEN 1 ELSE 0 END;`)}
CREATE OR REPLACE TRIGGER stages_latest AFTER INSERT ON stages FOR EACH ROW EXECUTE FUNCTION trg_stages_latest();`,
  },
  tracked_repos_ever: {
    source: "257a1a877e6d0e1d",
    pg: `${fn("tracked_repos_ever", "  INSERT INTO ever_tracked_repos (name) VALUES (NEW.name) ON CONFLICT DO NOTHING;")}
CREATE OR REPLACE TRIGGER tracked_repos_ever AFTER INSERT ON tracked_repos FOR EACH ROW EXECUTE FUNCTION trg_tracked_repos_ever();`,
  },
  items_fts_ai: { source: "2817a0f8dbd1dbd5", pg: FTS_NONE },
  items_fts_ad: { source: "55f54c0773c08714", pg: FTS_NONE },
  items_fts_au: { source: "8dca86f47f1532d6", pg: FTS_NONE },
  comments_fts_ai: { source: "711e5654af1ea63f", pg: FTS_NONE },
  comments_fts_ad: { source: "1842a6de98a5cda9", pg: FTS_NONE },
  comments_fts_au: { source: "4ffe01ac1b4f0253", pg: FTS_NONE },
  item_plans_rev_i: { source: "9f667d06ba239596", pg: `${PLAN_REV_FN}\n${planRev("item_plans_rev_i", "INSERT")}` },
  item_plans_rev_u: { source: "34a2f2ad3a488dc3", pg: planRev("item_plans_rev_u", "UPDATE") },
  item_plans_rev_d: { source: "89c65c63fa9fc99b", pg: planRev("item_plans_rev_d", "DELETE") },
  decision_items_ins: {
    source: "c8f43779ac3d1cf8",
    pg: `${fn("decision_items_ins", `  IF ${DECISION_ITEMS_WHEN} THEN\n${DECISION_ITEMS_INSERT}\n  END IF;`)}
CREATE OR REPLACE TRIGGER decision_items_ins AFTER INSERT ON decisions FOR EACH ROW EXECUTE FUNCTION trg_decision_items_ins();`,
  },
  decision_items_upd: {
    source: "813ef5289fc47009",
    pg: `${fn("decision_items_upd", `  DELETE FROM decision_items WHERE decision_id = NEW.id;\n  IF ${DECISION_ITEMS_WHEN} THEN\n${DECISION_ITEMS_INSERT}\n  END IF;`)}
CREATE OR REPLACE TRIGGER decision_items_upd AFTER UPDATE ON decisions FOR EACH ROW
  WHEN (OLD.items IS DISTINCT FROM NEW.items OR OLD.number IS DISTINCT FROM NEW.number) EXECUTE FUNCTION trg_decision_items_upd();`,
  },
  decision_items_del: {
    source: "b4b7aa18677dfde8",
    pg: `${fn("decision_items_del", "  DELETE FROM decision_items WHERE decision_id = OLD.id;")}
CREATE OR REPLACE TRIGGER decision_items_del AFTER DELETE ON decisions FOR EACH ROW EXECUTE FUNCTION trg_decision_items_del();`,
  },
  discord_links_alerts: {
    source: "ff367fa4423febe4",
    pg: `${fn("discord_links_alerts", `  DELETE FROM discord_alerts WHERE user_hash = OLD.user_hash;
  DELETE FROM discord_alert_msgs WHERE user_hash = OLD.user_hash;`)}
CREATE OR REPLACE TRIGGER discord_links_alerts AFTER DELETE ON discord_links FOR EACH ROW EXECUTE FUNCTION trg_discord_links_alerts();`,
  },
  jobs_ever: { source: "9420d638eb1638c5", pg: ever("jobs_ever", "jobs") },
  build_tasks_ever: { source: "3669296ce2a795ea", pg: ever("build_tasks_ever", "build_tasks") },
  agent_run_items_ever: { source: "c8db631ac90b69c3", pg: ever("agent_run_items_ever", "agent_run_items") },
  // Self-updating triggers (ADDED_INDEXES) set NEW in a BEFORE UPDATE trigger instead of updating the row again.
  decisions_answered_role: {
    source: "47e3f80a81045e2f",
    pg: `${fn("decisions_answered_role", "  NEW.answered_role := (SELECT role FROM access WHERE login = NEW.answered_by::citext);", "NEW")}
CREATE OR REPLACE TRIGGER decisions_answered_role BEFORE UPDATE OF answered_by ON decisions FOR EACH ROW EXECUTE FUNCTION trg_decisions_answered_role();`,
  },
  items_hash_stale: {
    source: "05a8d9d6724cd3a7",
    pg: `${fn("items_hash_stale", "  NEW.embed_hash := NULL;\n  NEW.class_hash := NULL;\n  NEW.class_scheme := NULL;", "NEW")}
CREATE OR REPLACE TRIGGER items_hash_stale BEFORE UPDATE OF title, body, additions, deletions, changed_files, author_association, kind ON items FOR EACH ROW
  WHEN (NEW.embed_hash IS NOT DISTINCT FROM OLD.embed_hash AND NEW.class_hash IS NOT DISTINCT FROM OLD.class_hash AND NEW.class_scheme IS NOT DISTINCT FROM OLD.class_scheme
    AND (OLD.title IS DISTINCT FROM NEW.title OR OLD.body IS DISTINCT FROM NEW.body OR OLD.additions IS DISTINCT FROM NEW.additions
      OR OLD.deletions IS DISTINCT FROM NEW.deletions OR OLD.changed_files IS DISTINCT FROM NEW.changed_files
      OR OLD.author_association IS DISTINCT FROM NEW.author_association OR OLD.kind IS DISTINCT FROM NEW.kind))
  EXECUTE FUNCTION trg_items_hash_stale();`,
  },
  items_text_refs_stale: {
    source: "d52b29f11aee0b45",
    pg: `${fn("items_text_refs_stale", "  NEW.text_refs := NULL;", "NEW")}
CREATE OR REPLACE TRIGGER items_text_refs_stale BEFORE UPDATE OF title, body ON items FOR EACH ROW
  WHEN (NEW.text_refs IS NOT NULL AND NEW.text_refs IS NOT DISTINCT FROM OLD.text_refs AND (OLD.title IS DISTINCT FROM NEW.title OR OLD.body IS DISTINCT FROM NEW.body))
  EXECUTE FUNCTION trg_items_text_refs_stale();`,
  },
};

// ---- Tokens ----

type Tok = { t: "id" | "qid" | "str" | "num" | "op" | "p"; v: string; pos: number };

export class SchemaError extends Error {}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const fail = (what: string): never => {
    throw new SchemaError(`unsupported ${what} at: ${src.slice(i, i + 80)}`);
  };
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) i++;
    else if (src.startsWith("--", i)) i = src.indexOf("\n", i) < 0 ? src.length : src.indexOf("\n", i);
    else if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) fail("unterminated comment");
      i = end + 2;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= src.length) fail("unterminated quote");
        if (src[j] === c) {
          if (src[j + 1] === c) j += 2;
          else break;
        } else j++;
      }
      out.push({ t: c === "'" ? "str" : "qid", v: src.slice(i, j + 1), pos: i });
      i = j + 1;
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      out.push({ t: "num", v: m[0], pos: i });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: "id", v: m[0], pos: i });
      i += m[0].length;
    } else if ("(),;.".includes(c)) {
      out.push({ t: "p", v: c, pos: i });
      i++;
    } else {
      const m = /^(\|\||<>|!=|<=|>=|==|[=<>+\-*/%])/.exec(src.slice(i));
      if (!m) fail(`character '${c}'`);
      out.push({ t: "op", v: m![0], pos: i });
      i += m![0].length;
    }
  }
  return out;
}

const isKw = (tok: Tok | undefined, ...words: string[]) => tok?.t === "id" && words.includes(tok.v.toUpperCase());

type Stmt = { toks: Tok[]; text: string };

/** Splits at top-level semicolons; a trigger runs from CREATE to the END that closes its BEGIN (CASE ... END nests). */
function statements(src: string): Stmt[] {
  const toks = tokenize(src);
  const out: Stmt[] = [];
  let start = 0;
  let inTrigger = false, inBody = false, cases = 0;
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i]!;
    if (i === start) inTrigger = isKw(tok, "CREATE") && (isKw(toks[i + 1], "TRIGGER") || (isKw(toks[i + 1], "TEMP", "TEMPORARY") && isKw(toks[i + 2], "TRIGGER")));
    if (inTrigger) {
      if (!inBody && isKw(tok, "BEGIN")) inBody = true;
      else if (inBody && isKw(tok, "CASE")) cases++;
      else if (inBody && isKw(tok, "END")) {
        if (cases) cases--;
        else inBody = inTrigger = false;
      }
      continue;
    }
    if (tok.t === "p" && tok.v === ";") {
      if (i > start) out.push(stmtOf(src, toks, start, i));
      start = i + 1;
    }
  }
  if (start < toks.length) out.push(stmtOf(src, toks, start, toks.length));
  return out;
}

function stmtOf(src: string, toks: Tok[], from: number, to: number): Stmt {
  const last = toks[to - 1]!;
  return { toks: toks.slice(from, to), text: src.slice(toks[from]!.pos, last.pos + last.v.length) };
}

export const sourceHash = (s: Stmt): string => createHash("sha256").update(s.toks.map((t) => t.v).join(" ")).digest("hex").slice(0, 16);

// ---- Translation ----

type Column = { name: string; type: string; pk: boolean; autoinc: boolean; notNull: boolean; unique: boolean; dflt: string | null; check: string | null; nocase: boolean };

class Translator {
  readonly out: string[] = [];
  /** Views go last: SQLite resolves a view's columns only when it is read, so a view may name added columns. */
  readonly views: string[] = [];
  /** Columns by table, filled as tables are translated (citext columns drop COLLATE NOCASE in indexes). */
  readonly tables = new Map<string, Map<string, Column>>();
  readonly names = new Set<string>();
  readonly dropped = new Set(DROPPED_COLUMNS.map(([t, c]) => `${t}.${c}`));
  readonly seenTriggers = new Set<string>();

  fail(s: Stmt, why: string): never {
    throw new SchemaError(`${why}\nin statement: ${s.text.slice(0, 600)}`);
  }

  ident(s: Stmt, tok: Tok | undefined): string {
    if (tok?.t === "qid") return tok.v.slice(1, -1).replace(/""/g, '"');
    if (tok?.t !== "id") this.fail(s, `expected a name, got ${tok?.v ?? "end of statement"}`);
    return tok!.v;
  }

  /** A name as Postgres DDL writes it: quoted when it is a reserved word; longer than 63 bytes fails. */
  q(s: Stmt, name: string): string {
    if (Buffer.byteLength(name) > 63) this.fail(s, `name longer than 63 bytes: ${name}`);
    return RESERVED.has(name.toLowerCase()) || !/^[a-z_][a-z0-9_]*$/.test(name) ? `"${name.replace(/"/g, '""')}"` : name;
  }

  /** `[main.]name` at toks[i]; returns the name and the next index. */
  qualified(s: Stmt, i: number): [string, number] {
    if (isKw(s.toks[i], "MAIN") && s.toks[i + 1]?.v === ".") i += 2;
    else if (s.toks[i + 1]?.v === ".") this.fail(s, "schema other than main");
    return [this.ident(s, s.toks[i]), i + 1];
  }

  run(s: Stmt): void {
    const k = s.toks.slice(0, 4).map((t) => t.v.toUpperCase()).join(" ");
    if (k.startsWith("CREATE TABLE")) this.table(s);
    else if (k.startsWith("CREATE INDEX") || k.startsWith("CREATE UNIQUE INDEX")) this.index(s);
    else if (k.startsWith("CREATE VIRTUAL TABLE")) this.fts(s);
    else if (k.startsWith("CREATE TRIGGER")) this.trigger(s);
    else if (k.startsWith("DROP TRIGGER IF EXISTS")) this.dropTrigger(s);
    else if (k.startsWith("DROP VIEW IF EXISTS")) this.views.push(`DROP VIEW IF EXISTS ${this.q(s, this.qualified(s, 4)[0])};`);
    else if (k.startsWith("CREATE VIEW")) this.view(s);
    else if (k.startsWith("INSERT")) this.insert(s);
    else this.fail(s, "unsupported statement");
  }

  table(s: Stmt): void {
    const t = s.toks;
    if (!isKw(t[2], "IF") || !isKw(t[3], "NOT") || !isKw(t[4], "EXISTS")) this.fail(s, "CREATE TABLE without IF NOT EXISTS");
    const [name, i] = this.qualified(s, 5);
    if (t[i]?.v !== "(") this.fail(s, "CREATE TABLE ... AS or a missing column list");
    const close = this.closing(s, i);
    const tail = t.slice(close + 1).map((x) => x.v.toUpperCase()).join(" ");
    if (tail !== "" && tail !== "WITHOUT ROWID") this.fail(s, `unsupported table option: ${tail}`);
    const rowidTable = tail === "";
    const cols = new Map<string, Column>();
    const constraints: { kind: "pk" | "unique" | "check"; cols?: string[]; expr?: string }[] = [];
    for (const def of this.split(s, i + 1, close)) {
      if (isKw(def[0], "PRIMARY", "UNIQUE")) {
        const pk = isKw(def[0], "PRIMARY");
        const open = pk ? 2 : 1;
        if (pk && !isKw(def[1], "KEY")) this.fail(s, "PRIMARY without KEY");
        if (def[open]?.v !== "(" || def[def.length - 1]?.v !== ")") this.fail(s, "unsupported key constraint");
        const names = this.splitToks(def.slice(open + 1, -1)).map((c) => (c.length === 1 ? this.ident(s, c[0]) : this.fail(s, "key column with options")));
        constraints.push({ kind: pk ? "pk" : "unique", cols: names });
      } else if (isKw(def[0], "CHECK")) {
        constraints.push({ kind: "check", expr: this.expr(s, def.slice(1)) });
      } else if (isKw(def[0], "CONSTRAINT", "FOREIGN")) this.fail(s, `unsupported table constraint ${def[0]!.v}`);
      else {
        const col = this.column(s, def);
        if (cols.has(col.name)) this.fail(s, `duplicate column ${col.name}`);
        cols.set(col.name, col);
      }
    }
    for (const c of constraints) for (const n of c.cols ?? []) if (!cols.has(n)) this.fail(s, `constraint names unknown column ${n}`);
    this.tables.set(name, cols);
    this.names.add(name);
    for (const c of cols.keys()) this.names.add(c);
    // The INTEGER PRIMARY KEY of a rowid table is the rowid: an identity column on Postgres.
    const pkCols = [...cols.values()].filter((c) => c.pk).map((c) => c.name);
    const tablePk = constraints.find((c) => c.kind === "pk")?.cols ?? [];
    if (pkCols.length + (tablePk.length ? 1 : 0) > 1) this.fail(s, "more than one primary key");
    const keyCols = pkCols.length ? pkCols : tablePk;
    const alias = rowidTable && keyCols.length === 1 && cols.get(keyCols[0]!)!.type === "INTEGER" ? keyCols[0]! : null;
    for (const c of cols.values()) if (c.autoinc && c.name !== alias) this.fail(s, "AUTOINCREMENT on a column that is not the rowid");
    const lines: string[] = [];
    for (const c of cols.values()) {
      if (this.dropped.has(`${name}.${c.name}`)) continue;
      lines.push(`  ${this.q(s, c.name)} ${this.columnSql(s, name, c, c.name === alias)}`);
    }
    if (rowidTable && !alias) {
      if (cols.has("rowid")) this.fail(s, "a column named rowid");
      lines.push("  rowid bigint GENERATED BY DEFAULT AS IDENTITY UNIQUE");
    }
    for (const c of constraints) {
      if (c.kind === "check") lines.push(`  CHECK ${c.expr}`);
      else lines.push(`  ${c.kind === "pk" ? "PRIMARY KEY" : "UNIQUE"} (${c.cols!.map((n) => this.q(s, n)).join(", ")})`);
    }
    this.out.push(`CREATE TABLE IF NOT EXISTS ${this.q(s, name)} (\n${lines.join(",\n")}\n);`);
  }

  column(s: Stmt, def: Tok[]): Column {
    const name = this.ident(s, def[0]);
    const type = def[1]?.t === "id" ? def[1].v.toUpperCase() : "";
    if (!["INTEGER", "TEXT", "REAL", "BLOB"].includes(type)) this.fail(s, `column ${name}: unsupported or missing type ${def[1]?.v ?? ""}`);
    const c: Column = { name, type, pk: false, autoinc: false, notNull: false, unique: false, dflt: null, check: null, nocase: false };
    let i = 2;
    while (i < def.length) {
      const tok = def[i]!;
      if (isKw(tok, "PRIMARY") && isKw(def[i + 1], "KEY")) {
        c.pk = true;
        i += 2;
        if (isKw(def[i], "AUTOINCREMENT")) {
          c.autoinc = true;
          i++;
        }
      } else if (isKw(tok, "NOT") && isKw(def[i + 1], "NULL")) {
        c.notNull = true;
        i += 2;
      } else if (isKw(tok, "UNIQUE")) {
        c.unique = true;
        i++;
      } else if (isKw(tok, "DEFAULT")) {
        const v = def[i + 1];
        if (v?.t === "str" || v?.t === "num" || isKw(v, "NULL")) {
          c.dflt = isKw(v, "NULL") ? "NULL" : v!.v;
          i += 2;
        } else if (v?.v === "-" && def[i + 2]?.t === "num") {
          c.dflt = `-${def[i + 2]!.v}`;
          i += 3;
        } else this.fail(s, `column ${name}: unsupported default`);
      } else if (isKw(tok, "CHECK") && def[i + 1]?.v === "(") {
        const close = this.closingIn(s, def, i + 1);
        c.check = this.expr(s, def.slice(i + 1, close + 1));
        i = close + 1;
      } else if (isKw(tok, "COLLATE") && isKw(def[i + 1], "NOCASE")) {
        c.nocase = true;
        i += 2;
      } else this.fail(s, `column ${name}: unsupported constraint ${tok.v}`);
    }
    if (c.nocase && type !== "TEXT") this.fail(s, `column ${name}: NOCASE on a ${type} column`);
    return c;
  }

  columnSql(s: Stmt, table: string, c: Column, identity: boolean): string {
    const override = TYPE_OVERRIDES[`${table}.${c.name}`];
    const type = identity ? "bigint GENERATED BY DEFAULT AS IDENTITY"
      : override ?? { INTEGER: "bigint", REAL: "double precision", BLOB: "bytea", TEXT: c.nocase ? 'citext COLLATE "C"' : 'text COLLATE "C"' }[c.type]!;
    const parts = [type];
    if (c.pk) parts.push("PRIMARY KEY");
    if (c.notNull) parts.push("NOT NULL");
    if (c.unique) parts.push("UNIQUE");
    if (c.dflt !== null) {
      if (override && c.dflt !== "NULL") this.fail(s, `column ${c.name}: default on an overridden type`);
      parts.push(`DEFAULT ${c.dflt}`);
    }
    if (c.check) parts.push(`CHECK ${c.check}`);
    return parts.join(" ");
  }

  index(s: Stmt): void {
    const t = s.toks;
    const unique = isKw(t[1], "UNIQUE");
    let i = unique ? 3 : 2;
    if (!isKw(t[i], "IF") || !isKw(t[i + 1], "NOT") || !isKw(t[i + 2], "EXISTS")) this.fail(s, "CREATE INDEX without IF NOT EXISTS");
    let name: string;
    [name, i] = this.qualified(s, i + 3);
    if (!isKw(t[i], "ON")) this.fail(s, "expected ON");
    let table: string;
    [table, i] = this.qualified(s, i + 1);
    const cols = this.tables.get(table) ?? this.fail(s, `index on unknown table ${table}`);
    if (t[i]?.v !== "(") this.fail(s, "expected a column list");
    const close = this.closing(s, i);
    const parts = this.split(s, i + 1, close).map((p) => {
      if (p[1]?.v === "(") this.fail(s, "expression index");
      const col = this.ident(s, p[0]);
      const known = cols.get(col) ?? this.fail(s, `index names unknown column ${col}`);
      let sql = this.q(s, col);
      let j = 1;
      if (isKw(p[j], "COLLATE")) {
        if (!isKw(p[j + 1], "NOCASE")) this.fail(s, "unsupported collation");
        // On a citext column the comparison is already case-insensitive; on a text column the index holds lower(col).
        if (!known.nocase) sql = `lower(${sql})`;
        j += 2;
      }
      if (isKw(p[j], "ASC", "DESC")) sql += ` ${p[j++]!.v.toUpperCase()}`;
      if (j !== p.length) this.fail(s, "unsupported index column");
      return sql;
    });
    let where = "";
    if (close + 1 < t.length) {
      if (!isKw(t[close + 1], "WHERE")) this.fail(s, "unsupported index option");
      where = ` WHERE ${this.expr(s, t.slice(close + 2))}`;
    }
    this.out.push(`CREATE ${unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${this.q(s, name)} ON ${this.q(s, table)} (${parts.join(", ")})${where};`);
  }

  fts(s: Stmt): void {
    const t = s.toks;
    if (!isKw(t[3], "IF") || !isKw(t[4], "NOT") || !isKw(t[5], "EXISTS")) this.fail(s, "CREATE VIRTUAL TABLE without IF NOT EXISTS");
    const [name, i] = this.qualified(s, 6);
    if (!isKw(t[i], "USING") || !isKw(t[i + 1], "FTS5") || t[i + 2]?.v !== "(") this.fail(s, "virtual table other than fts5");
    const close = this.closing(s, i + 2);
    if (close !== t.length - 1) this.fail(s, "text after the fts5 arguments");
    const cols: string[] = [];
    const opts: Record<string, string> = {};
    for (const a of this.split(s, i + 3, close)) {
      if (a.length === 1) cols.push(this.ident(s, a[0]));
      else if (a.length === 3 && a[0]!.t === "id" && a[1]!.v === "=" && a[2]!.t === "str") opts[a[0]!.v.toLowerCase()] = a[2]!.v;
      else this.fail(s, "unsupported fts5 argument");
    }
    const base = opts.content?.slice(1, -1) ?? this.fail(s, "fts5 table without external content");
    if (opts.content_rowid !== "'rowid'" || opts.tokenize !== FTS_TOKENIZE || Object.keys(opts).length !== 3) this.fail(s, "unsupported fts5 options");
    const baseCols = this.tables.get(base) ?? this.fail(s, `fts5 content table ${base} is not defined before it`);
    const parts = cols.map((c) => {
      const w = FTS_WEIGHTS[c] ?? this.fail(s, `no search weight for fts5 column ${c}`);
      if (!baseCols.has(c)) this.fail(s, `fts5 column ${c} is not a column of ${base}`);
      return `setweight(to_tsvector('english'::regconfig, coalesce(${this.q(s, c)}, '')), '${w}')`;
    });
    this.out.push(`ALTER TABLE ${this.q(s, base)} ADD COLUMN IF NOT EXISTS fts tsvector GENERATED ALWAYS AS (${parts.join(" || ")}) STORED;`);
    this.out.push(`CREATE INDEX IF NOT EXISTS ${this.q(s, name)} ON ${this.q(s, base)} USING gin (fts);`);
  }

  trigger(s: Stmt): void {
    let i = 2;
    if (isKw(s.toks[i], "IF")) i += 3;
    const name = this.qualified(s, i)[0];
    const hand = HAND_TRIGGERS[name] ?? this.fail(s, `trigger ${name} has no hand translation (HAND_TRIGGERS in src/db/pg-schema.ts)`);
    const hash = sourceHash(s);
    if (hand.source !== hash) this.fail(s, `trigger ${name} changed in SQLite (source hash ${hash}); update its hand translation and hash`);
    this.seenTriggers.add(name);
    this.out.push(typeof hand.pg === "string" ? hand.pg : `-- ${name}: none on Postgres, ${hand.pg.none}.`);
  }

  dropTrigger(s: Stmt): void {
    const name = this.qualified(s, 4)[0];
    // Every hand trigger is created with CREATE OR REPLACE, which already replaces an older body.
    if (!HAND_TRIGGERS[name] || s.toks.length !== 5 + (isKw(s.toks[4], "MAIN") ? 2 : 0)) this.fail(s, `DROP TRIGGER of ${name}`);
  }

  view(s: Stmt): void {
    const [name, i] = this.qualified(s, 2);
    if (!isKw(s.toks[i], "AS") || !isKw(s.toks[i + 1], "SELECT")) this.fail(s, "unsupported view");
    this.views.push(`CREATE VIEW ${this.q(s, name)} AS ${this.expr(s, s.toks.slice(i + 1))};`);
  }

  insert(s: Stmt): void {
    const t = s.toks;
    let i = 1;
    let ignore = false;
    if (isKw(t[1], "OR")) {
      if (!isKw(t[2], "IGNORE")) this.fail(s, `INSERT OR ${t[2]?.v}`);
      ignore = true;
      i = 3;
    }
    if (!isKw(t[i], "INTO")) this.fail(s, "expected INTO");
    const [table, j] = this.qualified(s, i + 1);
    if (!this.tables.has(table)) this.fail(s, `insert into unknown table ${table}`);
    if (t.some((x) => isKw(x, "ON") && isKw(t[t.indexOf(x) + 1], "CONFLICT"))) this.fail(s, "ON CONFLICT in a seed");
    this.out.push(`INSERT INTO ${this.q(s, table)} ${this.expr(s, t.slice(j))}${ignore ? " ON CONFLICT DO NOTHING" : ""};`);
  }

  /** An expression, column list or SELECT: allowlisted keywords and functions only. */
  expr(s: Stmt, toks: Tok[]): string {
    const KEYWORDS = new Set(["SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "NULL", "IN", "EXISTS", "VALUES", "AS", "CASE", "WHEN", "THEN", "ELSE", "END"]);
    const FUNCS = new Set(["coalesce"]);
    // strftime formats used with 'now' in the schema, and their to_char equivalents (UTC, as SQLite's 'now').
    const STRFTIME: Record<string, string> = {
      "'%Y-%m-%dT%H:%M:%SZ'": `'YYYY-MM-DD"T"HH24:MI:SS"Z"'`,
      "'%Y-%m-%dT%H:%M:%fZ'": `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`,
    };
    const out: string[] = [];
    for (let i = 0; i < toks.length; i++) {
      const tok = toks[i]!;
      const next = toks[i + 1];
      if (tok.t === "id") {
        const up = tok.v.toUpperCase();
        if (up === "MAIN" && next?.v === ".") {
          i++;
          continue;
        }
        if (next?.v === "(" && !KEYWORDS.has(up)) {
          const f = tok.v.toLowerCase();
          if (f === "strftime") {
            const fmt = STRFTIME[toks[i + 2]?.v ?? ""];
            if (!fmt || toks[i + 3]?.v !== "," || toks[i + 4]?.v !== "'now'" || toks[i + 5]?.v !== ")") this.fail(s, "unsupported strftime call");
            out.push(`to_char(statement_timestamp() AT TIME ZONE 'UTC', ${fmt})`);
            i += 5;
            continue;
          }
          if (!FUNCS.has(f)) this.fail(s, `unsupported function ${tok.v}`);
          out.push(f);
          continue;
        }
        if (up === "IS") {
          if (isKw(next, "NOT")) {
            if (isKw(toks[i + 2], "NULL")) out.push("IS NOT NULL");
            else out.push("IS DISTINCT FROM");
            i += isKw(toks[i + 2], "NULL") ? 2 : 1;
          } else if (isKw(next, "NULL")) {
            out.push("IS NULL");
            i++;
          } else out.push("IS NOT DISTINCT FROM");
          continue;
        }
        if (KEYWORDS.has(up)) out.push(up);
        else if (RESERVED.has(tok.v.toLowerCase())) {
          if (!this.names.has(tok.v)) this.fail(s, `unsupported keyword ${tok.v}`);
          out.push(this.q(s, tok.v));
        } else out.push(tok.v);
      } else if (tok.t === "op") out.push(tok.v === "==" ? "=" : tok.v);
      else out.push(tok.v);
    }
    return out.join(" ").replace(/\( /g, "(").replace(/ \)/g, ")").replace(/ ,/g, ",").replace(/ \. /g, ".").replace(/(\w+) \(/g, (m, w: string) => (/^(IN|AS|VALUES|EXISTS|AND|OR|NOT|WHEN|THEN|ELSE|FROM|SELECT|WHERE)$/i.test(w) ? m : `${w}(`));
  }

  /** Index of the parenthesis closing the one at `open`. */
  closing(s: Stmt, open: number): number {
    return this.closingIn(s, s.toks, open);
  }

  closingIn(s: Stmt, toks: Tok[], open: number): number {
    let depth = 0;
    for (let i = open; i < toks.length; i++) {
      if (toks[i]!.v === "(" && toks[i]!.t === "p") depth++;
      else if (toks[i]!.v === ")" && toks[i]!.t === "p" && --depth === 0) return i;
    }
    return this.fail(s, "unbalanced parentheses");
  }

  /** The comma-separated parts of s.toks[from, to). */
  split(s: Stmt, from: number, to: number): Tok[][] {
    const parts = this.splitToks(s.toks.slice(from, to));
    if (parts.some((p) => p.length === 0)) this.fail(s, "empty list element");
    return parts;
  }

  splitToks(toks: Tok[]): Tok[][] {
    const parts: Tok[][] = [[]];
    let depth = 0;
    for (const tok of toks) {
      if (tok.t === "p" && tok.v === "(") depth++;
      if (tok.t === "p" && tok.v === ")") depth--;
      if (depth === 0 && tok.t === "p" && tok.v === ",") parts.push([]);
      else parts[parts.length - 1]!.push(tok);
    }
    return parts;
  }

  addedColumns(): void {
    for (const [table, column, type] of ADDED_COLUMNS) {
      const s: Stmt = { toks: tokenize(`${column} ${type}`), text: `ADDED_COLUMNS ${table}.${column} ${type}` };
      const cols = this.tables.get(table) ?? this.fail(s, `added column on unknown table ${table}`);
      const c = this.column(s, s.toks);
      if (c.pk || c.unique || c.autoinc) this.fail(s, "key constraint on an added column");
      const have = cols.get(column);
      if (have && (have.type !== c.type || have.nocase !== c.nocase)) this.fail(s, "added column differs from the table's definition");
      cols.set(column, c);
      this.names.add(column);
      this.out.push(`ALTER TABLE ${this.q(s, table)} ADD COLUMN IF NOT EXISTS ${this.q(s, column)} ${this.columnSql(s, table, c, false)};`);
    }
  }
}

const SCHEMA_URL = new URL("../schema.sql", import.meta.url);

/** Translates SQLite schema text; throws SchemaError on anything outside the allowlist. Exposed for the tests. */
export function translateSqlite(sql: string, opts: { added?: boolean } = {}): string {
  const tr = new Translator();
  for (const s of statements(sql)) tr.run(s);
  if (opts.added) {
    tr.out.push("-- Columns and indexes added after the tables' first release (src/db.ts).");
    tr.addedColumns();
    for (const ix of ADDED_INDEXES) for (const s of statements(ix)) tr.run(s);
    const missing = Object.keys(HAND_TRIGGERS).filter((n) => !tr.seenTriggers.has(n));
    if (missing.length) throw new SchemaError(`hand-translated triggers no longer in the SQLite schema: ${missing.join(", ")}`);
  }
  return [...tr.out, ...tr.views].join("\n");
}

/** The full Postgres schema file: header with dialect and stamp, compat pack, translated schema. */
export function renderPgSchema(): string {
  const body = `${COMPAT_SQL}\n\n${translateSqlite(readFileSync(SCHEMA_URL, "utf8"), { added: true })}\n`;
  // The views of the scoped schema select * from these tables, and migratePg replaces them only after the schema.
  const shape = /\b(ALTER\s+COLUMN\s+\w+\s+(SET\s+DATA\s+)?TYPE|DROP\s+COLUMN|RENAME\s+COLUMN|RENAME\s+TO)\b/i.exec(body.replace(/^\s*--.*$/gm, ""));
  if (shape) {
    throw new Error(`src/schema.pg.sql would contain "${shape[0]}": a view in schema scoped depends on the table, so migratePg (src/db/pg-triggers.ts) must drop that table's view in the same step first`);
  }
  const stamp = createHash("sha256").update(`${PG_DIALECT}\n${body}`).digest("hex").slice(0, 16);
  return `-- Generated by scripts/gen-pg-schema.ts from src/schema.sql and the added columns and indexes in src/db.ts. Do not edit.
-- dialect: ${PG_DIALECT}; stamp: ${stamp}
-- Identity columns start at 1: after a data copy, each identity sequence is set past the copied keys (setval).
${body}`;
}
