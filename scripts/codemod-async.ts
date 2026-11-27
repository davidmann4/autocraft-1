// Turns synchronous node:sqlite code into async code over the Db interface of src/db/index.ts (the Postgres plan, "Sync → async").
//
//   node scripts/codemod-async.ts [--root DIR] [--check] [--report [PREFIX]] [--db-types A,B] [--stmt-types A,B] [--local P,Q]
//
// Passes, in order:
//   1. Transactions: `X.exec("BEGIN IMMEDIATE"); try { ...; X.exec("COMMIT"); } catch (e) { X.exec("ROLLBACK"); throw e; }` and the
//      same without try become `await X.write(async () => { ... })`; plain BEGIN blocks become `X.read` (or `X.write` when the block
//      writes). Other shapes are left as they are and reported.
//   2. Awaits: every statement call (get/all/run on a statement type), every exec/close/write/read on a database type, every
//      `connect(...)` and every call of a function that becomes async gets `await`; the enclosing function becomes async and its
//      declared return type is wrapped in Promise. This runs to a fixpoint over the whole program: callers, project function types
//      the function is assigned to (and every other function assigned to them), class members and the members they implement.
//      connect() and what only it calls stay synchronous (connectDb() wraps its DatabaseSync); a function other server code
//      calls too becomes async, and connect()'s call of it is reported.
//   3. Array callbacks that become async (map, filter, some, every, find, findIndex, findLast, forEach, reduce, sort, flatMap)
//      become the sequential helpers of src/async-seq.ts.
//   4. The Db API: `DatabaseSync`/`StatementSync` types → `Db`/`Statement`, `X.exec(sql)` → `X.script(sql)`, `X.isTransaction` →
//      `X.inTransaction()`, `for (... of stmt.iterate())` → `for await`, `prep(db, sql)` → `db.prepare(sql)`,
//      `connect(path, opts)` → `connectDb(path, opts)` and `connect()` → `openDb()`, with the imports to match.
// SQL text is never changed. The edits are deterministic and a second run changes nothing.
// --report writes PREFIX.json and PREFIX.md (default scripts/codemod-async-report): counts, residue that needs hand work, and
// read-then-write candidates per subsystem. --check changes no file and exits 1 when a run would change one.
// TypeScript 7 has no compiler API, so this uses TypeScript 5 under the `ts5` alias.
import ts from "ts5";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

export type Options = {
  rootDir: string;
  dbTypes?: string[];
  stmtTypes?: string[];
  /** Root-relative file or directory prefixes holding local SQLite files that stay synchronous: no call there seeds an await. */
  local?: string[];
  /** Root-relative path of the sequential helpers module. */
  seqModule?: string;
  /** Root-relative prefixes never edited and never seeding an await (the database layer itself). */
  noEdit?: string[];
  /** `file#function` roots whose whole call tree stays synchronous. The first is the `connect` that connectDb()/openDb() replace. */
  syncRoots?: string[];
  /** `file#function` of the statement cache whose calls become `db.prepare`. */
  prep?: string;
  dbModule?: string;
  openModule?: string;
};

export type Residue = { kind: string; file: string; line: number; fn: string; detail: string };
export type Rmw = { file: string; line: number; fn: string; read: string; write: string };
export type Report = {
  files: number;
  functions: number;
  signatures: number;
  awaits: number;
  returnTypes: number;
  seq: Record<string, number>;
  transactions: { write: number; read: number; plain: string[] };
  residue: Residue[];
  residueCounts: Record<string, number>;
  rmw: Record<string, Rmw[]>;
};

// src/remote/tools.ts keeps the item-tools snapshot on a synchronous DatabaseSync, and src/github/read.ts opens its
// read-only DatabaseSync before wrapping it with dbFor; the rest of both files is async already.
const DEFAULT_LOCAL = ["src/itemtools/", "src/data/external/", "src/remote/tools.ts", "src/github/read.ts"];
const DEFAULT_NO_EDIT = ["src/db/", "src/async-seq.ts", "test/db-layer.test.ts"];
const under = (rel: string, ps: string[]) => ps.some((p) => rel === p || (p.endsWith("/") && rel.startsWith(p)));
const RENAME: Record<string, string> = { DatabaseSync: "Db", StatementSync: "Statement" };
const STMT_METHODS = new Set(["get", "all", "run"]);
const DB_METHODS = new Set(["exec", "close", "write", "read", "script"]);
const isTxSqlText = (sql: string) => /^\s*(BEGIN|COMMIT|END|ROLLBACK)\b/i.test(sql);
const SEQ: Record<string, string> = {
  map: "mapSeq", flatMap: "flatMapSeq", filter: "filterSeq", forEach: "forEachSeq", some: "someSeq", every: "everySeq",
  find: "findSeq", findIndex: "findIndexSeq", findLast: "findLastSeq", reduce: "reduceSeq", sort: "sortSeq",
};
const SEQ_ARGS: Record<string, number> = { reduce: 2 };

type Edit = { start: number; end: number; text: string; rank: number };
type FnLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration | ts.ConstructorDeclaration;
type SigLike = ts.FunctionTypeNode | ts.MethodSignature | ts.CallSignatureDeclaration | ts.FunctionDeclaration | ts.MethodDeclaration;
type Unit = FnLike | SigLike;
type Ctx =
  | { kind: "project"; decl: Unit }
  | { kind: "array"; method: string; call: ts.CallExpression }
  | { kind: "void" | "promise" | "sync" | "array-odd"; detail: string }
  | { kind: "generic"; call: ts.CallExpression | ts.NewExpression | undefined; detail: string }
  | { kind: "throws"; call: ts.CallExpression };

const isFnLike = (n: ts.Node): n is FnLike =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isConstructorDeclaration(n);

const hasMod = (n: ts.Node, k: ts.SyntaxKind) => !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === k));
const isAsync = (n: ts.Node) => hasMod(n, ts.SyntaxKind.AsyncKeyword);

function unparen(n: ts.Node): ts.Node {
  let p = n.parent;
  while (p && ts.isParenthesizedExpression(p)) p = p.parent;
  return p;
}

// ---------------------------------------------------------------- pass 1: transactions

const execArg = (s: ts.Node, recv?: string): { recv: string; sql: string } | null => {
  const e = ts.isExpressionStatement(s) ? s.expression : s;
  if (!ts.isCallExpression(e) || !ts.isPropertyAccessExpression(e.expression) || e.expression.name.text !== "exec" || e.arguments.length !== 1) return null;
  const a = e.arguments[0];
  if (!ts.isStringLiteral(a) && !ts.isNoSubstitutionTemplateLiteral(a)) return null;
  const r = e.expression.expression.getText();
  if (recv !== undefined && r !== recv) return null;
  return { recv: r, sql: a.text.trim().toUpperCase().replace(/;$/, "") };
};

const isTxSql = (sql: string) => /^(BEGIN|COMMIT|END|ROLLBACK)\b/.test(sql);
const isRollback = (s: ts.Statement, recv: string) =>
  execArg(s, recv)?.sql === "ROLLBACK" ||
  (ts.isIfStatement(s) && !s.elseStatement && /^\S+\.isTransaction$/.test(s.expression.getText()) && execArg(ts.isBlock(s.thenStatement) && s.thenStatement.statements.length === 1 ? s.thenStatement.statements[0] : s.thenStatement, recv)?.sql === "ROLLBACK");

/** What a block of statements does that cannot move into a callback: returns, breaks or continues to outer targets, yields, tx statements. */
function scanBody(stmts: readonly ts.Statement[], recv: string) {
  let ret = false, escape = false, yields = false, tx = false, calls = false, writes = false;
  const visit = (n: ts.Node, loopDepth: number, switchDepth: number) => {
    if (isFnLike(n) || ts.isClassLike(n)) return;
    if (ts.isReturnStatement(n)) ret = true;
    if ((ts.isBreakStatement(n) && (n.label || (loopDepth === 0 && switchDepth === 0))) || (ts.isContinueStatement(n) && (n.label || loopDepth === 0))) escape = true;
    if (ts.isYieldExpression(n)) yields = true;
    if (ts.isCallExpression(n)) {
      calls = true;
      const x = execArg(n);
      if (x && x.recv === recv && isTxSql(x.sql)) tx = true;
      if (x && !isTxSql(x.sql)) writes = true;
      if (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "run") writes = true;
    }
    const loop = ts.isIterationStatement(n, false) ? 1 : 0;
    const sw = ts.isSwitchStatement(n) ? 1 : 0;
    ts.forEachChild(n, (c) => visit(c, loopDepth + loop, switchDepth + sw));
  };
  for (const s of stmts) visit(s, 0, 0);
  return { ret, escape, yields, tx, calls, writes };
}

function lineIndent(text: string, pos: number): string {
  const ls = text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(ls))![0];
}

type TxResult = { text: string; edits: number; deferred?: boolean; write: number; read: number; plain: string[]; residue: Residue[] };

export function rewriteTransactions(sf: ts.SourceFile, rel: string, keep: Set<string> = new Set()): TxResult {
  const text = sf.text;
  const edits: Edit[] = [];
  const out: TxResult = { text, edits: 0, write: 0, read: 0, plain: [], residue: [] };
  const res = (kind: string, n: ts.Node, detail: string) => out.residue.push({ kind, file: rel, line: lineOf(sf, n), fn: fnName(n), detail });
  const visitList = (stmts: readonly ts.Statement[], owner: ts.Node) => {
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i];
      const b = execArg(s);
      if (keep.has(fnName(s))) continue;
      if (!b || !/^BEGIN\b/.test(b.sql)) {
        if (ts.isIfStatement(s) && execArg(s.thenStatement)?.sql.startsWith("BEGIN")) res("transaction", s, "conditional BEGIN: the Db joins nested transactions, so this can become db.write");
        continue;
      }
      const recv = b.recv;
      const immediate = /^BEGIN\s+IMMEDIATE\b/.test(b.sql);
      if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(recv)) { res("transaction", s, `receiver ${recv} is not a plain name`); continue; }
      let body: readonly ts.Statement[], tail: readonly ts.Statement[] = [], endNode: ts.Node, consumed: number;
      const next = stmts[i + 1];
      if (next && ts.isTryStatement(next)) {
        const ts_ = next.tryBlock.statements;
        const ci = ts_.findLastIndex((x) => { const e = execArg(x, recv); return e?.sql === "COMMIT" || e?.sql === "END"; });
        const cc = next.catchClause;
        const v = cc?.variableDeclaration?.name;
        const okCatch = cc && v && ts.isIdentifier(v) && cc.block.statements.length === 2 && isRollback(cc.block.statements[0], recv) &&
          ts.isThrowStatement(cc.block.statements[1]) && cc.block.statements[1].expression?.getText() === v.text;
        if (ci < 0 || !okCatch || next.finallyBlock) { res("transaction", s, "try block of another shape (no COMMIT at the end, a catch other than ROLLBACK + rethrow, or a finally)"); continue; }
        body = ts_.slice(0, ci);
        tail = ts_.slice(ci + 1);
        if (scanBody(tail, recv).calls) { res("transaction", s, "statements with calls after COMMIT inside the try"); continue; }
        endNode = next;
        consumed = 1;
      } else {
        const j = stmts.findIndex((x, k) => k > i && execArg(x, recv) !== null && isTxSql(execArg(x, recv)!.sql));
        if (j < 0 || !["COMMIT", "END"].includes(execArg(stmts[j], recv)!.sql)) { res("transaction", s, "BEGIN without a matching COMMIT in the same block"); continue; }
        body = stmts.slice(i + 1, j);
        endNode = stmts[j];
        consumed = j - i;
      }
      const sc = scanBody([...body, ...tail], recv);
      if (sc.tx) { res("transaction", s, "ROLLBACK, COMMIT or BEGIN inside the block (early rollback and return): needs a hand rewrite"); continue; }
      if (sc.escape) { res("transaction", s, "break or continue leaves the block"); continue; }
      if (sc.yields) { res("transaction", s, "yield inside the block"); continue; }
      const isFnBody = ts.isBlock(owner) && isFnLike(owner.parent) && owner.parent.body === owner;
      const last = i + consumed === stmts.length - 1;
      if (sc.ret && !(isFnBody && last)) { res("transaction", s, "return inside the block, which is not the end of the function"); continue; }
      const kind = immediate || sc.writes ? "write" : "read";
      if (!immediate) out.plain.push(`${rel}:${lineOf(sf, s)} ${fnName(s)} -> ${kind}`);
      const ind = lineIndent(text, s.getStart(sf));
      const slice = (xs: readonly ts.Statement[]) => (xs.length ? text.slice(xs[0].getFullStart(), xs[xs.length - 1].end) : "");
      const inner = slice(body) + slice(tail);
      edits.push({ start: s.getStart(sf), end: endNode.end, text: `${sc.ret ? "return " : ""}await ${recv}.${kind}(async () => {${inner}\n${ind}});`, rank: 0 });
      out[kind]++;
      i += consumed;
    }
  };
  const visit = (n: ts.Node) => {
    if (ts.isSourceFile(n) || ts.isBlock(n) || ts.isModuleBlock(n)) visitList(n.statements, n);
    else if (ts.isCaseClause(n) || ts.isDefaultClause(n)) visitList(n.statements, n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  // A transaction inside another one's block is rewritten in a later round, from the outer one's new text.
  const top = edits.filter((e) => !edits.some((o) => o !== e && o.start <= e.start && e.end <= o.end));
  out.edits = top.length;
  out.deferred = top.length < edits.length;
  out.text = applyEdits(text, top);
  return out;
}

/** Rewrites transactions in rounds until none is left; residue comes from the last round, on the final text. */
export function rewriteTransactionsAll(sf: ts.SourceFile, rel: string, keep?: Set<string>): TxResult {
  let r = rewriteTransactions(sf, rel, keep);
  const total: TxResult = { ...r, plain: [...r.plain] };
  while (r.edits) {
    r = rewriteTransactions(ts.createSourceFile(sf.fileName, r.text, ts.ScriptTarget.Latest, true, sf.fileName.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.Unknown), rel, keep);
    total.text = r.text;
    total.edits += r.edits;
    total.write += r.write;
    total.read += r.read;
    total.plain.push(...r.plain);
    total.residue = r.residue;
  }
  return total;
}

function applyEdits(text: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end || b.rank - a.rank);
  let s = text;
  for (const e of sorted) s = s.slice(0, e.start) + e.text + s.slice(e.end);
  return s;
}

// ---------------------------------------------------------------- helpers

function lineOf(sf: ts.SourceFile, n: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
}

function nameOf(n: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isMethodSignature(n) || ts.isPropertySignature(n) || ts.isPropertyDeclaration(n) || ts.isPropertyAssignment(n)) && n.name) return n.name.getText();
  if (ts.isConstructorDeclaration(n)) return "constructor";
  if (ts.isVariableDeclaration(n)) return n.name.getText();
  return undefined;
}

/** A readable name for the function containing `n` (or `n` itself), for reports. */
export function fnName(n: ts.Node): string {
  const parts: string[] = [];
  for (let p: ts.Node | undefined = n; p && !ts.isSourceFile(p); p = p.parent) {
    if (isFnLike(p) || ts.isClassLike(p)) {
      let nm = nameOf(p) ?? (ts.isClassLike(p) ? p.name?.text : undefined);
      if (!nm && p.parent) nm = nameOf(p.parent);
      if (!nm && p.parent && ts.isCallExpression(p.parent) && ts.isPropertyAccessExpression(p.parent.expression)) nm = `${p.parent.expression.name.text}-callback`;
      parts.unshift(nm ?? "<anonymous>");
    }
  }
  return parts.join(".") || "<top-level>";
}

/** The `file#function` declaration in `program`, if any. */
function findFnIn(program: ts.Program, root: string, spec: string): ts.FunctionDeclaration | undefined {
  const [file, name] = spec.split("#");
  const sf = program.getSourceFile(resolve(root, file));
  return sf?.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name && !!s.body);
}

/** `roots`, every function they call (transitively) and every function nested in those: the code that stays synchronous. */
function syncTree(checker: ts.TypeChecker, roots: FnLike[], inScope: (sf: ts.SourceFile) => boolean, stop: Set<FnLike> = new Set()): Set<FnLike> {
  const set = new Set<FnLike>();
  const stack = [...roots];
  while (stack.length) {
    const u = stack.pop()!;
    if (set.has(u) || stop.has(u)) continue;
    set.add(u);
    const visit = (n: ts.Node) => {
      if (isFnLike(n) && n !== u) { stack.push(n); return; }
      if (ts.isCallExpression(n)) {
        let d = checker.getResolvedSignature(n)?.getDeclaration() as ts.Node | undefined;
        if (d && (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) && !d.body && d.name) {
          d = checker.getSymbolAtLocation(d.name)?.declarations?.find((x) => (ts.isFunctionDeclaration(x) || ts.isMethodDeclaration(x)) && !!x.body);
        }
        if (d && isFnLike(d) && d.body && inScope(d.getSourceFile())) stack.push(d);
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(u, visit);
  }
  return set;
}

// ---------------------------------------------------------------- pass 2: awaits to a fixpoint

class Codemod {
  readonly checker: ts.TypeChecker;
  readonly root: string;
  readonly dbTypes: Set<string>;
  readonly stmtTypes: Set<string>;
  readonly local: string[];
  readonly seqModule: string;
  readonly files: ts.SourceFile[] = [];
  readonly callSites = new Map<Unit, ts.CallExpression[]>();
  readonly links = new Map<Unit, Set<Unit>>();
  readonly ctxOf = new Map<Unit, Ctx[]>();
  readonly overloads = new Map<Unit, ts.SignatureDeclaration[]>();
  readonly dbCalls: { call: ts.CallExpression; kind: "stmt" | "db" }[] = [];
  readonly awaitSeeds: ts.AwaitExpression[] = [];
  readonly txCalls = new Set<ts.CallExpression>();
  readonly done = new Set<Unit>();
  readonly marked = new Set<Unit>();
  readonly needAwait = new Set<ts.CallExpression | ts.NewExpression>();
  readonly seqCalls = new Map<ts.CallExpression, string>();
  readonly residue: Residue[] = [];
  readonly origAsyncCache = new Map<Unit, boolean>();
  readonly noEdit: string[];
  readonly syncSet = new Set<FnLike>();
  readonly syncRoots: FnLike[] = [];
  connectDecl: FnLike | undefined;
  prepDecl: FnLike | undefined;
  readonly typeRefs: ts.TypeReferenceNode[] = [];
  readonly isTxProps: ts.PropertyAccessExpression[] = [];
  readonly prepCalls: ts.CallExpression[] = [];
  readonly connectCalls: ts.CallExpression[] = [];
  readonly forAwait: ts.ForOfStatement[] = [];
  readonly returnTypeRefs: ts.TypeReferenceNode[] = [];
  readonly rejects = new Set<ts.CallExpression>();
  readonly opts: Options;

  readonly program: ts.Program;

  constructor(program: ts.Program, o: Options) {
    this.program = program;
    this.checker = program.getTypeChecker();
    this.root = resolve(o.rootDir);
    this.dbTypes = new Set(o.dbTypes ?? ["DatabaseSync", "Db"]);
    this.stmtTypes = new Set(o.stmtTypes ?? ["StatementSync"]);
    this.local = o.local ?? DEFAULT_LOCAL;
    this.seqModule = o.seqModule ?? "src/async-seq.ts";
    this.noEdit = o.noEdit ?? DEFAULT_NO_EDIT;
    this.opts = o;
    for (const sf of program.getSourceFiles()) if (this.isProjectFile(sf.fileName) && !sf.isDeclarationFile) this.files.push(sf);
    this.files.sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0));
  }

  rel(f: string) { return relative(this.root, f); }
  isProjectFile(f: string) { const r = relative(this.root, f); return !r.startsWith("..") && !r.includes("node_modules"); }
  isLocal(sf: ts.SourceFile) { const r = this.rel(sf.fileName); return under(r, this.local) || under(r, this.noEdit); }
  editable(n: ts.Node) { const sf = n.getSourceFile(); return !this.isLocal(sf) && !this.inSync(n); }

  /** True when `n` runs inside connect()'s call tree, which stays synchronous. */
  inSync(n: ts.Node): boolean {
    for (let p: ts.Node | undefined = n; p; p = p.parent) if (isFnLike(p) && this.syncSet.has(p)) return true;
    return false;
  }

  findFn(spec: string): FnLike | undefined { return findFnIn(this.program, this.root, spec); }

  /**
   * connect()'s call tree minus the functions other server code calls too: those become async like the rest, and connect()'s
   * calls of them are reported. Callers in tests do not count; they get the DatabaseSync connect() returns.
   */
  computeSync() {
    const roots = this.opts.syncRoots ?? ["src/db.ts#connect"];
    this.syncRoots.length = 0;
    for (const r of roots) { const f = this.findFn(r); if (f) this.syncRoots.push(f); }
    const inScope = (sf: ts.SourceFile) => this.isProjectFile(sf.fileName) && !this.isLocal(sf);
    const stop = new Set<FnLike>();
    for (;;) {
      this.syncSet.clear();
      for (const f of syncTree(this.checker, this.syncRoots, inScope, stop)) this.syncSet.add(f);
      const before = stop.size;
      for (const f of this.syncSet) {
        if (this.syncRoots.includes(f)) continue;
        if ((this.callSites.get(f) ?? []).some((c) => this.rel(c.getSourceFile().fileName).startsWith("src/") && !this.isLocal(c.getSourceFile()) && !this.inSync(c))) stop.add(f);
      }
      if (stop.size === before) return;
    }
  }

  isSqliteType(id: ts.Identifier): boolean {
    if (!RENAME[id.text]) return false;
    let sym = this.checker.getSymbolAtLocation(id);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = this.checker.getAliasedSymbol(sym);
    const f = sym?.declarations?.[0]?.getSourceFile().fileName ?? "";
    return f.endsWith("/sqlite.d.ts");
  }

  res(kind: string, n: ts.Node, detail: string) {
    const sf = n.getSourceFile();
    this.residue.push({ kind, file: this.rel(sf.fileName), line: lineOf(sf, n), fn: fnName(n), detail });
  }

  typeName(t: ts.Type): string | undefined {
    t = this.checker.getNonNullableType(t);
    return t.aliasSymbol?.name ?? t.getSymbol()?.name;
  }

  /** The kind of database call `call` is, if any. */
  dbCall(call: ts.CallExpression): "stmt" | "db" | "iterate" | null {
    const e = call.expression;
    if (!ts.isPropertyAccessExpression(e)) return null;
    const m = e.name.text;
    if (!STMT_METHODS.has(m) && !DB_METHODS.has(m) && m !== "iterate") return null;
    const tn = this.typeName(this.checker.getTypeAtLocation(e.expression));
    if (!tn) return null;
    if (this.stmtTypes.has(tn)) return STMT_METHODS.has(m) ? "stmt" : m === "iterate" ? "iterate" : null;
    if (this.dbTypes.has(tn) && DB_METHODS.has(m)) return "db";
    return null;
  }

  /** The unit (function with a body, or a project function type) a declaration stands for; undefined outside the project. */
  unitOf(d: ts.Declaration | undefined): Unit | undefined {
    if (!d || !this.isProjectFile(d.getSourceFile().fileName)) return undefined;
    if ((ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) && !d.body) {
      const sym = d.name && this.checker.getSymbolAtLocation(d.name);
      const impl = sym?.declarations?.find((x) => (ts.isFunctionDeclaration(x) || ts.isMethodDeclaration(x)) && x.body) as Unit | undefined;
      return impl ?? d;
    }
    if (isFnLike(d) || ts.isFunctionTypeNode(d) || ts.isMethodSignature(d) || ts.isCallSignatureDeclaration(d)) return d as Unit;
    return undefined;
  }

  link(a: Unit, b: Unit) {
    if (a === b) return;
    for (const [x, y] of [[a, b], [b, a]] as const) {
      let s = this.links.get(x);
      if (!s) this.links.set(x, (s = new Set()));
      s.add(y);
    }
  }

  addCtx(u: Unit, c: Ctx) {
    let l = this.ctxOf.get(u);
    if (!l) this.ctxOf.set(u, (l = []));
    l.push(c);
  }

  /** How the function value at `n` (a function expression, or a reference to a named function) will be called. */
  classifyCtx(n: ts.Expression, sig: ts.Signature | undefined): Ctx | undefined {
    const decl = sig?.getDeclaration();
    if (!decl) return undefined;
    const pu = this.unitOf(decl);
    if (pu) return { kind: "project", decl: pu };
    // An array method's callback parameter: FunctionType -> Parameter -> MethodSignature -> interface Array/ReadonlyArray.
    const par = decl.parent;
    const meth = par && ts.isParameter(par) ? par.parent : undefined;
    const iface = meth?.parent;
    const mname = meth && ts.isMethodSignature(meth) ? meth.name.getText() : undefined;
    if (mname && iface && ts.isInterfaceDeclaration(iface) && (iface.name.text === "Array" || iface.name.text === "ReadonlyArray")) {
      const call = n.parent;
      if (SEQ[mname] && ts.isCallExpression(call) && call.arguments[0] === n && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === mname &&
        !call.questionDotToken && !call.expression.questionDotToken && call.arguments.length <= (SEQ_ARGS[mname] ?? 1)) return { kind: "array", method: mname, call };
      return { kind: "array-odd", detail: `Array.${mname} callback` };
    }
    const owner = iface && (ts.isInterfaceDeclaration(iface) || ts.isClassDeclaration(iface)) && iface.name ? iface.name.text + "." : "";
    const where = par && ts.isParameter(par) && meth ? `${owner}${(meth as ts.SignatureDeclaration).name?.getText() ?? "?"}(${par.name.getText()})` : `${owner}${mname ?? nameOf(decl) ?? ts.SyntaxKind[decl.kind]}`;
    // assert.throws(fn) does not see a rejection: an async fn needs `await assert.rejects(fn)`.
    if (where === "throws(block)" && ts.isCallExpression(n.parent) && n.parent.arguments[0] === n && ts.isPropertyAccessExpression(n.parent.expression) && n.parent.expression.name.text === "throws") return { kind: "throws", call: n.parent };
    const rt = (decl as ts.SignatureDeclaration).type;
    if (!rt) return { kind: "sync", detail: `${where} (no declared return type)` };
    const parts = ts.isUnionTypeNode(rt) ? rt.types : [rt];
    if (parts.some((p) => ts.isTypeReferenceNode(p) && /^(Promise|PromiseLike)$/.test(p.typeName.getText()))) return { kind: "promise", detail: where };
    if (parts.every((p) => [ts.SyntaxKind.VoidKeyword, ts.SyntaxKind.AnyKeyword, ts.SyntaxKind.UnknownKeyword, ts.SyntaxKind.UndefinedKeyword].includes(p.kind))) return { kind: "void", detail: where };
    if (ts.isTypeReferenceNode(rt) && ts.isIdentifier(rt.typeName)) {
      const sym = this.checker.getSymbolAtLocation(rt.typeName);
      if (sym && sym.flags & ts.SymbolFlags.TypeParameter) {
        let outer = n.parent;
        while (outer && (ts.isParenthesizedExpression(outer) || ts.isAsExpression(outer))) outer = outer.parent;
        const oc = outer && (ts.isCallExpression(outer) || ts.isNewExpression(outer)) && outer.arguments?.includes(n as ts.Expression) ? outer : undefined;
        const od = oc && this.checker.getResolvedSignature(oc)?.getDeclaration();
        const ort = od && (od as ts.SignatureDeclaration).type;
        const mentions = !!ort && new RegExp(`\\b${rt.typeName.text}\\b`).test(ort.getText());
        return { kind: "generic", call: mentions ? oc : undefined, detail: where };
      }
    }
    return { kind: "sync", detail: where };
  }

  contextualSig(n: ts.Expression): ts.Signature | undefined {
    const t = this.checker.getContextualType(n);
    if (!t) return undefined;
    const ts_ = t.isUnion() ? t.types : [t];
    for (const x of ts_) {
      const s = x.getCallSignatures();
      if (s.length) return s[0];
    }
    return undefined;
  }

  /** The function type a value at `n` is assigned to; for `{ name }` the type of the property. */
  valueSig(n: ts.Expression): ts.Signature | undefined {
    const p = n.parent;
    if (ts.isShorthandPropertyAssignment(p)) {
      const ct = this.checker.getContextualType(p.parent);
      const prop = ct && this.checker.getPropertyOfType(ct, p.name.text);
      return prop ? this.checker.getTypeOfSymbolAtLocation(prop, p).getCallSignatures()[0] : undefined;
    }
    return this.contextualSig(n);
  }

  /** Collects calls, database calls, contextual function types and class member links in one walk. */
  collect() {
    const valueParents = (n: ts.Node): boolean => {
      const p = n.parent;
      // Through `c ? f : g`, `f ?? g`, `f || g` and parentheses the value lands where the whole expression does.
      if (ts.isParenthesizedExpression(p) || (ts.isConditionalExpression(p) && p.condition !== n) ||
        (ts.isBinaryExpression(p) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(p.operatorToken.kind) && (p.right === n || p.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken))) return valueParents(p);
      return (ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(n as ts.Expression) ||
        (ts.isPropertyAssignment(p) && p.initializer === n) || ts.isShorthandPropertyAssignment(p) || ts.isArrayLiteralExpression(p) ||
        (ts.isReturnStatement(p) && p.expression === n) || (ts.isVariableDeclaration(p) && p.initializer === n && !!p.type) ||
        (ts.isBinaryExpression(p) && p.right === n && p.operatorToken.kind === ts.SyntaxKind.EqualsToken);
    };
    for (const sf of this.files) {
      const local = this.isLocal(sf);
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n)) {
          const k = this.dbCall(n);
          if (k === "iterate") {
            let top: ts.Node = n;
            while (ts.isParenthesizedExpression(top.parent) || ts.isAsExpression(top.parent)) top = top.parent;
            if (!local && ts.isForOfStatement(top.parent) && top.parent.expression === top) this.forAwait.push(top.parent);
            else if (!local) this.res("iterate", n, "statement iterate() outside a for-of: needs a hand rewrite");
          }
          else if (k) {
            if (!local) this.dbCalls.push({ call: n, kind: k });
            const m = (n.expression as ts.PropertyAccessExpression).name.text;
            if (m === "write" || m === "read") this.txCalls.add(n);
          } else {
            const u = this.unitOf(this.checker.getResolvedSignature(n)?.getDeclaration() as ts.Declaration | undefined);
            if (u) {
              let l = this.callSites.get(u);
              if (!l) this.callSites.set(u, (l = []));
              l.push(n);
            }
          }
        } else if (ts.isPropertyAccessExpression(n) && !local && (n.name.text === "isTransaction" || n.name.text === "columns" || n.name.text === "function" || n.name.text === "aggregate" || n.name.text === "setReadBigInts")) {
          const tn = this.typeName(this.checker.getTypeAtLocation(n.expression));
          if (tn && this.dbTypes.has(tn) && n.name.text === "isTransaction") this.isTxProps.push(n);
          else if (tn && (this.dbTypes.has(tn) || this.stmtTypes.has(tn))) this.res("db-method", n, `${tn}.${n.name.text}: no Db equivalent (db.sync or a dialect method)`);
        } else if (ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName) && this.isSqliteType(n.typeName)) {
          if (!local) this.typeRefs.push(n);
        } else if (ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName) && n.typeName.text === "ReturnType" && n.typeArguments?.length === 1 && ts.isTypeQueryNode(n.typeArguments[0]) && !(ts.isTypeReferenceNode(n.parent) && n.parent.typeName.getText() === "Awaited")) {
          this.returnTypeRefs.push(n);
        } else if (ts.isAwaitExpression(n)) this.awaitSeeds.push(n);
        if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
          const c = this.classifyCtx(n, this.contextualSig(n));
          if (c) { this.addCtx(n, c); if (c.kind === "project") this.link(n, c.decl); }
        } else if (ts.isMethodDeclaration(n) && n.body) {
          if (ts.isObjectLiteralExpression(n.parent)) {
            const ct = this.checker.getContextualType(n.parent);
            const prop = ct && this.checker.getPropertyOfType(ct, n.name.getText());
            const sig = prop && this.checker.getTypeOfSymbolAtLocation(prop, n).getCallSignatures()[0];
            const d = this.unitOf(sig?.getDeclaration() as ts.Declaration | undefined);
            if (d) this.link(n, d);
          } else if (ts.isClassLike(n.parent)) {
            for (const h of n.parent.heritageClauses ?? []) for (const t of h.types) {
              const prop = this.checker.getTypeAtLocation(t).getProperty(n.name.getText());
              for (const d of prop?.declarations ?? []) { const u = this.unitOf(d); if (u) this.link(n, u); }
            }
          }
        }
        if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && !n.body && n.name) {
          const impl = this.unitOf(n);
          if (impl && impl !== n) { let l = this.overloads.get(impl); if (!l) this.overloads.set(impl, (l = [])); l.push(n); }
        }
        // A function value (a named function, a closure a call returned, a function-typed variable) passed on: whoever receives
        // it calls it, so it and the function type it lands in become async together.
        if ((ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) || ts.isCallExpression(n) || ts.isElementAccessExpression(n)) && !ts.isArrowFunction(n) && valueParents(n)) {
          const at = ts.isShorthandPropertyAssignment(n.parent) ? n.parent.name : n;
          const t = ts.isShorthandPropertyAssignment(n.parent) ? this.checker.getTypeOfSymbolAtLocation(this.checker.getShorthandAssignmentValueSymbol(n.parent)!, at) : this.checker.getTypeAtLocation(n);
          const sigs = t ? (t.isUnion() ? t.types : [t]).flatMap((x) => x.getCallSignatures()) : [];
          let c: Ctx | undefined | null = null;
          for (const sig of sigs) {
            const u = this.unitOf(sig.getDeclaration() as ts.Declaration | undefined);
            if (!u || ts.isConstructorDeclaration(u)) continue;
            if (c === null) c = this.classifyCtx(n as ts.Expression, this.valueSig(n as ts.Expression));
            if (!c) break;
            this.addCtx(u, c);
            if (c.kind === "project") this.link(u, c.decl);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  }

  /** True when the function already returned a promise (async, or typed or inferred as a promise). */
  origAsync(u: Unit): boolean {
    let v = this.origAsyncCache.get(u);
    if (v !== undefined) return v;
    v = isAsync(u);
    if (!v && !ts.isConstructorDeclaration(u) && !ts.isSetAccessorDeclaration(u)) {
      const sig = this.checker.getSignatureFromDeclaration(u as ts.SignatureDeclaration);
      const rt = sig && this.checker.getReturnTypeOfSignature(sig);
      v = !!rt && this.isThenable(rt);
    }
    this.origAsyncCache.set(u, v);
    return v;
  }

  isThenable(t: ts.Type): boolean {
    const ts_ = t.isUnion() ? t.types : [t];
    return ts_.length > 0 && ts_.every((x) => x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Never) || !!x.getProperty("then"));
  }

  /** The function whose body `n` runs in, or why there is none that can await. */
  enclosing(n: ts.Node): FnLike | "top-level" | { residue: string; at: ts.Node } {
    let prev = n;
    for (let p = n.parent; p; prev = p, p = p.parent) {
      if (ts.isParameter(p) && p.initializer === prev) return { residue: "initializer", at: p };
      if (ts.isPropertyDeclaration(p) && p.initializer === prev) return { residue: "initializer", at: p };
      if (ts.isClassStaticBlockDeclaration(p)) return { residue: "initializer", at: p };
      if (isFnLike(p)) return p;
      if (ts.isSourceFile(p)) return "top-level";
    }
    return "top-level";
  }

  cannotBeAsync(u: FnLike): string | null {
    if (ts.isGetAccessorDeclaration(u) || ts.isSetAccessorDeclaration(u)) return "accessor";
    if (ts.isConstructorDeclaration(u)) return "constructor";
    if (u.asteriskToken) return "generator";
    if (u.type && (ts.isTypePredicateNode(u.type))) return "type-predicate";
    return null;
  }

  /** Records that `call` must be awaited and makes its function async. */
  awaitCall(call: ts.CallExpression | ts.NewExpression | ts.ForOfStatement, why: string, insert = true) {
    if (this.inSync(call)) { this.res("connect-tree", call, `${why} inside connect()'s call tree, which stays synchronous`); return; }
    if (ts.isForOfStatement(call)) insert = false;
    const e = this.enclosing(call);
    if (e === "top-level") {
      this.res("top-level", call, `top-level await of ${why}`);
      if (insert && unparen(call)?.kind !== ts.SyntaxKind.AwaitExpression) this.needAwait.add(call as ts.CallExpression);
      return;
    }
    if ("residue" in e) { this.res(e.residue, e.at, `${why} in an initializer, which cannot await`); return; }
    const bad = this.cannotBeAsync(e);
    if (bad) { this.res(bad, e, `${why} inside a ${bad}, which cannot be async`); return; }
    if (insert && unparen(call)?.kind !== ts.SyntaxKind.AwaitExpression) this.needAwait.add(call as ts.CallExpression);
    this.makeAsync(e);
  }

  makeAsync(u: Unit) {
    if (this.done.has(u)) return;
    this.done.add(u);
    if (isFnLike(u)) {
      if (this.inSync(u)) { this.res("connect-tree", u, "would become async, but it is in connect()'s call tree"); return; }
      const bad = this.cannotBeAsync(u);
      if (bad) { this.res(bad, u, `would become async, which a ${bad} cannot be`); return; }
      if (this.origAsync(u)) { if (!isAsync(u)) this.marked.add(u); return; }
    } else if (!this.isProjectFile(u.getSourceFile().fileName)) return;
    this.marked.add(u);
    const name = nameOf(u) ?? fnName(u);
    for (const c of this.callSites.get(u) ?? []) this.awaitCall(c, `call of ${name}`);
    for (const l of this.links.get(u) ?? []) this.makeAsync(l);
    for (const c of this.ctxOf.get(u) ?? []) this.applyCtx(u, c);
  }

  applyCtx(u: Unit, c: Ctx) {
    switch (c.kind) {
      case "project": this.makeAsync(c.decl); break;
      case "array": {
        this.seqCalls.set(c.call, c.method);
        this.awaitCall(c.call, `${c.method} with an async callback`);
        break;
      }
      case "array-odd": this.res("sync-callback", u, `${c.detail} cannot take an async callback (optional chain, thisArg or no sequential helper)`); break;
      case "sync": this.res("sync-callback", u, `${c.detail} expects a synchronous result`); break;
      case "void": this.res("void-callback", u, `${c.detail} ignores the returned promise (fire and forget)`); break;
      case "generic":
        if (c.call) this.awaitCall(c.call, `${c.detail} returning the callback's promise`);
        else this.res("sync-callback", u, `${c.detail} is generic over the callback's result but does not return it`);
        break;
      case "throws":
        this.rejects.add(c.call);
        this.awaitCall(c.call, "assert.rejects");
        break;
      case "promise": break;
    }
  }

  run() {
    this.collect();
    this.computeSync();
    this.connectDecl = this.syncRoots[0];
    this.prepDecl = this.findFn(this.opts.prep ?? "src/sql-cache.ts#prep");
    // A function connect() calls that converted code calls too: it keeps its DatabaseSync, so those callers need a hand fix.
    for (const u of this.syncSet) {
      if (!u.parameters.some((p) => p.type && ts.isTypeReferenceNode(p.type) && ts.isIdentifier(p.type.typeName) && p.type.typeName.text === "DatabaseSync")) continue;
      const outside = (this.callSites.get(u) ?? []).filter((c) => !this.inSync(c) && !this.isLocal(c.getSourceFile()));
      if (outside.length) this.res("connect-tree", u, `called by connect() and by ${outside.length} converted call site(s), e.g. ${this.rel(outside[0].getSourceFile().fileName)}:${lineOf(outside[0].getSourceFile(), outside[0])}`);
    }
    for (const c of this.callSites.get(this.prepDecl as Unit) ?? []) if (this.editable(c)) this.prepCalls.push(c);
    for (const c of this.callSites.get(this.connectDecl as Unit) ?? []) {
      if (!this.editable(c)) continue;
      this.connectCalls.push(c);
      this.awaitCall(c, "connect");
    }
    for (const f of this.forAwait) this.awaitCall(f, "for await over iterate()");
    for (const { call } of this.dbCalls) {
      const m = (call.expression as ts.PropertyAccessExpression).name.text;
      const a = call.arguments[0];
      // BEGIN/COMMIT/ROLLBACK left by pass 1 are reported transactions: they stay exec() so the compiler points at them.
      if (m === "exec" && a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) && isTxSqlText(a.text)) continue;
      if (this.inSync(call)) continue;
      this.awaitCall(call, "a database call");
    }
    for (const a of this.awaitSeeds) {
      const e = this.enclosing(a);
      if (e !== "top-level" && !("residue" in e) && !isAsync(e) && !this.isLocal(e.getSourceFile())) this.makeAsync(e);
    }
  }

  // ---------------------------------------------------------------- edits

  needsParens(call: ts.Node): boolean {
    const p = call.parent;
    return (ts.isPropertyAccessExpression(p) && p.expression === call) || (ts.isElementAccessExpression(p) && p.expression === call) ||
      (ts.isCallExpression(p) && p.expression === call) || ts.isNonNullExpression(p) || ts.isTaggedTemplateExpression(p);
  }

  depth(n: ts.Node) { let d = 0; for (let p = n.parent; p; p = p.parent) d++; return d; }

  edits(): Map<ts.SourceFile, Edit[]> {
    const out = new Map<ts.SourceFile, Edit[]>();
    const add = (n: ts.Node, e: Edit) => {
      const sf = n.getSourceFile();
      let l = out.get(sf);
      if (!l) out.set(sf, (l = []));
      l.push(e);
    };
    for (const call of this.needAwait) {
      const sf = call.getSourceFile();
      const d = this.depth(call);
      const seq = ts.isCallExpression(call) ? this.seqCalls.get(call) : undefined;
      const par = this.needsParens(call);
      const start = call.getStart(sf);
      if (seq) {
        const pa = (call as ts.CallExpression).expression as ts.PropertyAccessExpression;
        add(call, { start, end: start, text: `${par ? "(" : ""}await ${SEQ[seq]}(`, rank: d });
        add(call, { start: pa.expression.end, end: (call as ts.CallExpression).arguments[0].getStart(sf), text: ", ", rank: 0 });
      } else add(call, { start, end: start, text: `${par ? "(" : ""}await `, rank: d });
      if (par) add(call, { start: call.end, end: call.end, text: ")", rank: -1e6 - d });
    }
    for (const u of this.marked) {
      const sf = u.getSourceFile();
      if (isFnLike(u) && !isAsync(u)) {
        let pos: number;
        if (ts.isFunctionDeclaration(u) || ts.isFunctionExpression(u)) pos = u.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.FunctionKeyword)!.getStart(sf);
        else if (ts.isMethodDeclaration(u)) pos = u.name.getStart(sf);
        else pos = u.getStart(sf);
        add(u, { start: pos, end: pos, text: "async ", rank: this.depth(u) });
      }
      if (isFnLike(u) && this.origAsync(u)) continue;
      for (const s of [u as ts.SignatureDeclaration, ...(this.overloads.get(u) ?? [])]) {
        const t = s.type;
        if (!t || (ts.isTypeReferenceNode(t) && /^(Promise|PromiseLike)$/.test(t.typeName.getText()))) continue;
        // Insertions, not a replacement: a function type inside this one may be wrapped too.
        const d = this.depth(t);
        add(s, { start: t.getStart(sf), end: t.getStart(sf), text: "Promise<", rank: d });
        add(s, { start: t.end, end: t.end, text: ">", rank: -1e6 - d });
      }
    }
    // The Db API.
    type Imp = { add: Set<string>; addType: Set<string>; remove: Set<string> };
    const imports = new Map<ts.SourceFile, Map<string, Imp>>();
    const imp = (sf: ts.SourceFile, mod: string) => {
      let m = imports.get(sf);
      if (!m) imports.set(sf, (m = new Map()));
      let i = m.get(mod);
      if (!i) m.set(mod, (i = { add: new Set(), addType: new Set(), remove: new Set() }));
      return i;
    };
    const rewritten = new Set<ts.Node>();
    const abs = (r: string) => resolve(this.root, r);
    for (const [call, m] of this.seqCalls) {
      if (!this.needAwait.has(call) && unparen(call)?.kind !== ts.SyntaxKind.AwaitExpression) continue;
      imp(call.getSourceFile(), abs(this.seqModule)).add.add(SEQ[m]);
    }
    for (const r of this.typeRefs) {
      if (!this.editable(r)) continue;
      const id = r.typeName as ts.Identifier;
      add(r, { start: id.getStart(), end: id.end, text: RENAME[id.text], rank: 0 });
      rewritten.add(id);
      imp(r.getSourceFile(), "node:sqlite").remove.add(id.text);
      imp(r.getSourceFile(), abs(this.opts.dbModule ?? "src/db/index.ts")).addType.add(RENAME[id.text]);
    }
    // ReturnType<typeof f> of a function that became async: the type of what awaiting it gives, as before.
    for (const r of this.returnTypeRefs) {
      const q = r.typeArguments![0] as ts.TypeQueryNode;
      let sym = this.checker.getSymbolAtLocation(ts.isQualifiedName(q.exprName) ? q.exprName.right : q.exprName);
      if (sym && sym.flags & ts.SymbolFlags.Alias) sym = this.checker.getAliasedSymbol(sym);
      let d: ts.Node | undefined = sym?.valueDeclaration;
      if (d && ts.isVariableDeclaration(d) && d.initializer) d = d.initializer;
      if (d && d === this.connectDecl && this.editable(r)) {
        add(r, { start: r.getStart(), end: r.end, text: "Db", rank: 0 });
        imp(r.getSourceFile(), abs(this.opts.dbModule ?? "src/db/index.ts")).addType.add("Db");
        rewritten.add((q.exprName as ts.Identifier));
        imp(r.getSourceFile(), this.connectDecl.getSourceFile().fileName).remove.add("connect");
        continue;
      }
      if (!d || !this.marked.has(d as Unit) || (isFnLike(d) && this.origAsync(d)) || !this.editable(r)) continue;
      const dd = this.depth(r);
      add(r, { start: r.getStart(), end: r.getStart(), text: "Awaited<", rank: dd });
      add(r, { start: r.end, end: r.end, text: ">", rank: -1e6 - dd });
    }
    for (const c of this.rejects) {
      const nm = (c.expression as ts.PropertyAccessExpression).name;
      if (this.editable(c)) add(c, { start: nm.getStart(), end: nm.end, text: "rejects", rank: 0 });
    }
    for (const p of this.isTxProps) if (this.editable(p)) add(p, { start: p.name.getStart(), end: p.name.end, text: "inTransaction()", rank: 0 });
    for (const { call } of this.dbCalls) {
      const pa = call.expression as ts.PropertyAccessExpression;
      const a = call.arguments[0];
      if (pa.name.text !== "exec" || !this.editable(call)) continue;
      if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) && isTxSqlText(a.text)) continue;
      add(call, { start: pa.name.getStart(), end: pa.name.end, text: "script", rank: 0 });
    }
    for (const f of this.forAwait) {
      if (f.awaitModifier || !this.editable(f)) continue;
      const sf = f.getSourceFile();
      const kw = f.getStart(sf) + 3;
      add(f, { start: kw, end: kw, text: " await", rank: 0 });
      let e: ts.Node = f.expression;
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      if (ts.isAsExpression(e) && ts.isTypeReferenceNode(e.type) && /^(Iterable|IterableIterator)$/.test(e.type.typeName.getText(sf)))
        add(e, { start: e.type.typeName.getStart(sf), end: e.type.typeName.end, text: "AsyncIterable", rank: 0 });
    }
    for (const c of this.prepCalls) {
      const sf = c.getSourceFile();
      const [d, q] = c.arguments;
      if (c.arguments.length !== 2 || !(ts.isIdentifier(d) || ts.isPropertyAccessExpression(d))) { this.res("prep", c, "prep() call of another shape"); continue; }
      add(c, { start: c.getStart(sf), end: q.getStart(sf), text: `${d.getText(sf)}.prepare(`, rank: 0 });
      rewritten.add(c.expression);
      imp(sf, abs((this.opts.prep ?? "src/sql-cache.ts#prep").split("#")[0])).remove.add("prep");
    }
    for (const c of this.connectCalls) {
      const sf = c.getSourceFile();
      const fn = c.arguments.length ? "connectDb" : "openDb";
      add(c, { start: c.expression.getStart(sf), end: c.expression.end, text: fn, rank: 0 });
      rewritten.add(c.expression);
      imp(sf, this.connectDecl!.getSourceFile().fileName).remove.add("connect");
      imp(sf, abs(this.opts.openModule ?? "src/db/open.ts")).add.add(fn);
    }
    for (const [sf, mods] of imports) for (const e of this.importEdits(sf, mods, rewritten)) add(sf, e);
    return out;
  }

  /** Import edits for `sf`: names added (value or type) and names removed once nothing in the file uses them. */
  importEdits(sf: ts.SourceFile, mods: Map<string, { add: Set<string>; addType: Set<string>; remove: Set<string> }>, rewritten: Set<ts.Node>): Edit[] {
    const edits: Edit[] = [];
    const decls = sf.statements.filter((s): s is ts.ImportDeclaration => ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier));
    const keyOf = (d: ts.ImportDeclaration) => { const t = (d.moduleSpecifier as ts.StringLiteral).text; return t.startsWith(".") ? resolve(dirname(sf.fileName), t) : t; };
    const stillUsed = (el: ts.ImportSpecifier): boolean => {
      const sym = this.checker.getSymbolAtLocation(el.name);
      let used = false;
      const visit = (n: ts.Node) => {
        if (used || ts.isImportDeclaration(n)) return;
        if (ts.isIdentifier(n) && n.text === el.name.text && !rewritten.has(n) && this.checker.getSymbolAtLocation(n) === sym) used = true;
        ts.forEachChild(n, visit);
      };
      visit(sf);
      return used;
    };
    const newLines: string[] = [];
    for (const [mod, want] of [...mods].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const mine = decls.filter((d) => keyOf(d) === mod);
      const have = new Set(mine.flatMap((d) => { const nb = d.importClause?.namedBindings; return nb && ts.isNamedImports(nb) ? nb.elements.map((e) => e.name.text) : []; }));
      const add = [...want.add].filter((n) => !have.has(n)).sort();
      const addType = [...want.addType].filter((n) => !have.has(n)).sort();
      const valueDecl = mine.find((d) => d.importClause && !d.importClause.isTypeOnly && (!d.importClause.namedBindings || ts.isNamedImports(d.importClause.namedBindings)));
      const typeDecl = mine.find((d) => d.importClause?.isTypeOnly && d.importClause.namedBindings && ts.isNamedImports(d.importClause.namedBindings));
      const extra = new Map<ts.ImportDeclaration, string[]>();
      if (add.length && valueDecl) { extra.set(valueDecl, add.splice(0)); }
      if (addType.length && (typeDecl ?? valueDecl)) {
        const d = (typeDecl ?? valueDecl)!;
        extra.set(d, [...(extra.get(d) ?? []), ...addType.splice(0).map((n) => (d === typeDecl ? n : `type ${n}`))]);
      }
      for (const d of mine) {
        const clause = d.importClause;
        const nb = clause?.namedBindings;
        if (!clause || (nb && !ts.isNamedImports(nb))) continue;
        const els = nb ? nb.elements : [];
        const kept = els.filter((e) => !(want.remove.has(e.name.text) && !stillUsed(e)));
        const more = extra.get(d) ?? [];
        if (kept.length === els.length && !more.length) continue;
        const list = [...kept.map((e) => e.getText(sf)), ...more];
        if (!list.length && !clause.name) {
          const end = sf.text[d.end] === "\n" ? d.end + 1 : d.end;
          edits.push({ start: d.getStart(sf), end, text: "", rank: 0 });
        } else if (nb) edits.push({ start: nb.getStart(sf), end: nb.end, text: list.length ? `{ ${list.join(", ")} }` : "{}", rank: 0 });
        else edits.push({ start: clause.name!.end, end: clause.name!.end, text: `, { ${list.join(", ")} }`, rank: 0 });
      }
      if (add.length || addType.length) {
        let spec = mod.startsWith("/") ? relative(dirname(sf.fileName), mod).replaceAll("\\", "/") : mod;
        if (mod.startsWith("/") && !spec.startsWith(".")) spec = "./" + spec;
        if (add.length) newLines.push(`import { ${add.join(", ")} } from "${spec}";`);
        if (addType.length) newLines.push(`import type { ${addType.join(", ")} } from "${spec}";`);
      }
    }
    if (newLines.length) {
      const last = decls[decls.length - 1];
      if (last) edits.push({ start: last.end, end: last.end, text: "\n" + newLines.join("\n"), rank: 1 });
      else { const p = sf.statements[0]?.getStart(sf) ?? 0; edits.push({ start: p, end: p, text: newLines.join("\n") + "\n", rank: 1 }); }
    }
    return edits;
  }

  // ---------------------------------------------------------------- read-then-write candidates

  rmw(): Record<string, Rmw[]> {
    type Ev = { r: boolean; w: boolean; what: string; line: number; unit?: Unit };
    const summary = new Map<Unit, { r: boolean; w: boolean }>();
    const events = new Map<Unit, Ev[]>();
    const units: Unit[] = [];
    const sqlOf = (call: ts.CallExpression): string | undefined => {
      let recv: ts.Expression = (call.expression as ts.PropertyAccessExpression).expression;
      if (ts.isIdentifier(recv)) {
        const d = this.checker.getSymbolAtLocation(recv)?.valueDeclaration;
        if (d && ts.isVariableDeclaration(d) && d.initializer) recv = d.initializer;
      }
      if (ts.isCallExpression(recv)) {
        const a = ts.isPropertyAccessExpression(recv.expression) && recv.expression.name.text === "prepare" ? recv.arguments[0] : ts.isIdentifier(recv.expression) && recv.expression.text === "prep" ? recv.arguments[1] : undefined;
        if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) return a.text;
        if (a && ts.isTemplateExpression(a)) return a.head.text;
      }
      return undefined;
    };
    const isSelect = (sql: string | undefined) => !!sql && /^\s*(SELECT|WITH\b(?![\s\S]*\b(INSERT|UPDATE|DELETE)\b))/i.test(sql);
    // Direct events per unit, in source order; loop bodies twice so a read late in an iteration precedes the next iteration's write.
    for (const sf of this.files) {
      const sfDb = new Map<ts.CallExpression, "stmt" | "db">();
      for (const d of this.dbCalls) if (d.call.getSourceFile() === sf) sfDb.set(d.call, d.kind);
      // `st.begun` follows BEGIN ... COMMIT left in place (unusual shapes); `tx` is true inside a write/read callback.
      type St = { ev: Ev[]; begun: boolean };
      const walk = (n: ts.Node, st: St, tx: boolean) => {
        if (isFnLike(n)) {
          const inline = n.parent && ts.isCallExpression(n.parent) && ts.isPropertyAccessExpression(n.parent.expression) && SEQ[n.parent.expression.name.text] !== undefined;
          if (!inline) { unitWalk(n); return; }
        }
        if (ts.isCallExpression(n)) {
          const k = sfDb.get(n);
          const m = ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : "";
          const line = lineOf(sf, n);
          const inTx = tx || st.begun;
          if (k === "db" && (m === "write" || m === "read")) {
            walk(n.expression, st, tx);
            const inner: St = { ev: [], begun: false };
            for (const arg of n.arguments) {
              if (isFnLike(arg)) ts.forEachChild(arg, (c) => walk(c, inner, true));
              else walk(arg, st, tx);
            }
            if (!inTx) st.ev.push({ r: m === "read" || inner.ev.some((e) => e.r), w: m === "write", what: `${m} block`, line });
            return;
          }
          ts.forEachChild(n, (c) => walk(c, st, tx));
          if (k === "stmt") {
            const sql = sqlOf(n);
            const w = m === "run" && !isSelect(sql);
            if (!inTx) st.ev.push({ r: !w, w, what: (sql ?? m).replace(/\s+/g, " ").trim().slice(0, 60), line });
          } else if (k === "db") {
            const a = n.arguments[0];
            const sql = a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) ? a.text.trim() : "";
            const up = sql.toUpperCase();
            if (m === "exec" && /^BEGIN\b/.test(up)) st.begun = true;
            else if (m === "exec" && isTxSql(up)) st.begun = false;
            else if (m === "exec" && !inTx) st.ev.push({ r: false, w: true, what: sql.replace(/\s+/g, " ").slice(0, 60) || "exec", line });
          } else if (!inTx) {
            const u = this.unitOf(this.checker.getResolvedSignature(n)?.getDeclaration() as ts.Declaration | undefined);
            if (u) st.ev.push({ r: false, w: false, what: `call ${nameOf(u) ?? fnName(u)}`, line, unit: u });
          }
          return;
        }
        if (ts.isIterationStatement(n, false)) { ts.forEachChild(n, (c) => walk(c, st, tx)); walk(n.statement, st, tx); return; }
        ts.forEachChild(n, (c) => walk(c, st, tx));
      };
      const unitWalk = (u: FnLike) => {
        if (events.has(u)) return;
        const st: St = { ev: [], begun: false };
        units.push(u);
        events.set(u, st.ev);
        ts.forEachChild(u, (c) => walk(c, st, false));
      };
      ts.forEachChild(sf, (c) => walk(c, { ev: [], begun: false }, false));
    }
    // Transitive read/write summaries.
    const sum = (u: Unit, seen: Set<Unit>): { r: boolean; w: boolean } => {
      const have = summary.get(u);
      if (have) return have;
      if (seen.has(u)) return { r: false, w: false };
      seen.add(u);
      const s = { r: false, w: false };
      for (const e of events.get(u) ?? []) {
        const cu = e.unit;
        const x = cu ? sum(cu, seen) : e;
        s.r ||= x.r;
        s.w ||= x.w;
      }
      seen.delete(u);
      if (!seen.size) summary.set(u, s);
      return s;
    };
    const out: Record<string, Rmw[]> = {};
    for (const u of units) {
      const sf = u.getSourceFile();
      const rel = this.rel(sf.fileName);
      if (!rel.startsWith("src/") || this.isLocal(sf)) continue;
      // Only called inside transactions: the caller's transaction covers it.
      const calls = this.callSites.get(u) ?? [];
      if (calls.length && calls.every((c) => this.insideTx(c))) continue;
      const ev = (events.get(u) ?? []).map((e) => { const cu = e.unit; return cu ? { ...e, ...sum(cu, new Set()) } : e; });
      const ri = ev.findIndex((e) => e.r);
      const wi = ri < 0 ? -1 : ev.findIndex((e, i) => i > ri && e.w);
      if (wi < 0) continue;
      const seg = rel.split("/");
      const sub = seg.length > 2 ? seg[1] : "(top-level)";
      (out[sub] ??= []).push({ file: rel, line: lineOf(sf, u), fn: fnName((u as FnLike).body ?? u), read: `${ev[ri].line}: ${ev[ri].what}`, write: `${ev[wi].line}: ${ev[wi].what}` });
    }
    for (const k of Object.keys(out)) out[k].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
  }

  insideTx(n: ts.Node): boolean {
    for (let p = n.parent; p; p = p.parent) if (ts.isCallExpression(p) && this.txCalls.has(p)) return true;
    return false;
  }
}

// ---------------------------------------------------------------- driver

export type RunResult = { changed: Map<string, string>; report: Report };

/** Runs both passes over `program`'s files under `rootDir`; returns the new text of every file that changes. */
export function runCodemod(makeProgram: (overrides: Map<string, string>) => ts.Program, o: Options): RunResult {
  const root = resolve(o.rootDir);
  const first = makeProgram(new Map());
  const overrides = new Map<string, string>();
  const tx = { write: 0, read: 0, plain: [] as string[] };
  const residue: Residue[] = [];
  const local = [...(o.local ?? DEFAULT_LOCAL), ...(o.noEdit ?? DEFAULT_NO_EDIT)];
  // Transactions in connect()'s call tree stay as they are; functions are matched by their name chain, which pass 1 does not change.
  const pre = new Codemod(first, o);
  pre.collect();
  pre.computeSync();
  const keepByFile = new Map<string, Set<string>>();
  for (const f of pre.syncSet) {
    const k = f.getSourceFile().fileName;
    let set = keepByFile.get(k);
    if (!set) keepByFile.set(k, (set = new Set()));
    set.add(fnName(f.body ?? f));
  }
  for (const sf of first.getSourceFiles()) {
    const rel = relative(root, sf.fileName);
    if (rel.startsWith("..") || rel.includes("node_modules") || sf.isDeclarationFile) continue;
    if (under(rel, local)) continue;
    const r = rewriteTransactionsAll(sf, rel, keepByFile.get(sf.fileName));
    residue.push(...r.residue);
    tx.write += r.write;
    tx.read += r.read;
    tx.plain.push(...r.plain);
    if (r.edits) overrides.set(sf.fileName, r.text);
  }
  const program = overrides.size ? makeProgram(overrides) : first;
  const cm = new Codemod(program, o);
  cm.run();
  const edits = cm.edits();
  const changed = new Map(overrides);
  for (const [sf, es] of edits) changed.set(sf.fileName, applyEdits(sf.text, es));
  residue.push(...cm.residue);
  const seen = new Set<string>();
  const uniq = residue.filter((r) => { const k = JSON.stringify(r); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.detail < b.detail ? -1 : 1)));
  const residueCounts: Record<string, number> = {};
  for (const r of uniq) residueCounts[r.kind] = (residueCounts[r.kind] ?? 0) + 1;
  const seq: Record<string, number> = {};
  for (const [c, m] of cm.seqCalls) if (cm.needAwait.has(c)) seq[m] = (seq[m] ?? 0) + 1;
  const marked = [...cm.marked];
  const report: Report = {
    files: changed.size,
    functions: marked.filter((u) => isFnLike(u) && !isAsync(u)).length,
    signatures: marked.filter((u) => !isFnLike(u)).length,
    awaits: cm.needAwait.size,
    returnTypes: marked.filter((u) => !(isFnLike(u) && cm.origAsync(u)) && (u as ts.SignatureDeclaration).type).length,
    seq: Object.fromEntries(Object.entries(seq).sort()),
    transactions: { ...tx, plain: tx.plain.sort() },
    residue: uniq,
    residueCounts: Object.fromEntries(Object.entries(residueCounts).sort()),
    rmw: cm.rmw(),
  };
  return { changed, report };
}

export function markdown(r: Report): string {
  const lines = [
    "# Async codemod report", "",
    `- Files changed: ${r.files}`, `- Functions made async: ${r.functions}`, `- Function types made async: ${r.signatures}`,
    `- Awaits inserted: ${r.awaits}`, `- Return types wrapped in Promise: ${r.returnTypes}`,
    `- Sequential helpers: ${Object.entries(r.seq).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
    `- Transactions rewritten: write ${r.transactions.write}, read ${r.transactions.read}`, "",
  ];
  if (r.transactions.plain.length) lines.push("## Plain BEGIN blocks (kind chosen from the block's own statements)", "", ...r.transactions.plain.map((p) => `- ${p}`), "");
  lines.push("## Residue for hand work", "", "| Kind | Count |", "| --- | --- |", ...Object.entries(r.residueCounts).map(([k, v]) => `| ${k} | ${v} |`), "");
  const byKind = new Map<string, Residue[]>();
  for (const x of r.residue) { let l = byKind.get(x.kind); if (!l) byKind.set(x.kind, (l = [])); l.push(x); }
  for (const [k, xs] of byKind) {
    lines.push(`### ${k}`, "");
    for (const x of xs) lines.push(`- ${x.file}:${x.line} \`${x.fn}\`: ${x.detail}`);
    lines.push("");
  }
  const total = Object.values(r.rmw).reduce((n, l) => n + l.length, 0);
  lines.push(`## Read-then-write candidates outside a transaction (${total})`, "", "| Subsystem | Functions |", "| --- | --- |",
    ...Object.entries(r.rmw).map(([k, l]) => `| ${k} | ${l.length} |`), "");
  for (const [k, l] of Object.entries(r.rmw)) {
    lines.push(`### ${k}`, "");
    for (const x of l) lines.push(`- ${x.file}:${x.line} \`${x.fn}\`: reads ${x.read}; writes ${x.write}`);
    lines.push("");
  }
  return lines.join("\n");
}

function main(argv: string[]) {
  const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const list = (name: string) => arg(name)?.split(",").filter(Boolean);
  const root = resolve(arg("--root") ?? process.cwd());
  const check = argv.includes("--check");
  const reportPrefix = argv.includes("--report") ? resolve(root, arg("--report") && !arg("--report")!.startsWith("--") ? arg("--report")! : "scripts/codemod-async-report") : undefined;
  const cfgPath = resolve(root, "tsconfig.json");
  const cfg = ts.getParsedCommandLineOfConfigFile(cfgPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n")); } });
  if (!cfg) throw new Error(`cannot read ${cfgPath}`);
  const makeProgram = (overrides: Map<string, string>) => {
    const host = ts.createCompilerHost(cfg.options, true);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (f, lang, onErr, create) => {
      const t = overrides.get(resolve(f));
      return t !== undefined ? ts.createSourceFile(f, t, lang, true) : getSourceFile(f, lang, onErr, create);
    };
    const readFile = host.readFile.bind(host);
    host.readFile = (f) => overrides.get(resolve(f)) ?? readFile(f);
    return ts.createProgram(cfg.fileNames, cfg.options, host);
  };
  const { changed, report } = runCodemod(makeProgram, { rootDir: root, dbTypes: list("--db-types"), stmtTypes: list("--stmt-types"), local: list("--local") });
  if (reportPrefix) {
    writeFileSync(reportPrefix + ".json", JSON.stringify(report, null, 1) + "\n");
    writeFileSync(reportPrefix + ".md", markdown(report) + "\n");
  }
  const real = [...changed].filter(([f, t]) => readFileSync(f, "utf8") !== t);
  if (check) {
    for (const [f] of real) console.log(`would change ${relative(root, f)}`);
    process.exitCode = real.length ? 1 : 0;
    return;
  }
  for (const [f, t] of real) writeFileSync(f, t);
  console.log(`${real.length} files changed, ${report.functions} functions made async, ${report.awaits} awaits, residue ${JSON.stringify(report.residueCounts)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
