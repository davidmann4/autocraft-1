import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "ts5";
import * as ast from "typescript/unstable/ast";
import { API, TypeFlags, type Type } from "typescript/unstable/sync";
import { fnName } from "../scripts/codemod-async.ts";

// A promise in an expression statement runs unobserved: its rejection is unhandled and the code after it does not wait for it.
// Deliberate fire-and-forget sites are written `void p` or listed in test/floating-promises.allow (file :: function :: statement).
const root = resolve(new URL("..", import.meta.url).pathname);
const ALLOW = resolve(root, "test/floating-promises.allow");

/** `file :: function :: statement` of the statement at `pos`. */
function describeSite(file: string, text: string, pos: number): string {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const find = (n: ts.Node): ts.Node | undefined => ts.isExpressionStatement(n) && n.getFullStart() === pos ? n : ts.forEachChild(n, find);
  const n = find(sf)!;
  return `${relative(root, file)} :: ${fnName(n)} :: ${n.getText(sf).replace(/\s+/g, " ").slice(0, 100).trim()}`;
}

// The types come from TypeScript 7's own process, asked for a file's statements at a time.
export function floatingPromises(): string[] {
  const config = resolve(root, "tsconfig.json");
  const api = new API({ cwd: root });
  try {
    const project = api.updateSnapshot({ openProjects: [config] }).getProject(config);
    if (!project) throw new Error("cannot read tsconfig.json");
    const { program, checker } = project;
    const hasThen = new Map<number, boolean>();
    const thenable = (t: Type): boolean => {
      if (t.flags & TypeFlags.Any) return false;
      let has = hasThen.get(t.id);
      if (has === undefined) {
        has = (t.isUnionType() ? t.getTypes() : [t]).some((x) => !!checker.getPropertyOfType(x, "then"));
        hasThen.set(t.id, has);
      }
      return has;
    };
    // node:test's test() and describe() return promises that the runner itself tracks.
    const fromNodeTest = (e: ast.Expression) => ast.isCallExpression(e) && !!checker.getResolvedSignature(e)?.declaration?.path.endsWith("/@types/node/test.d.ts");
    const found: string[] = [];
    for (const file of program.getSourceFileNames()) {
      const rel = relative(root, file);
      if (/\.d\.[cm]?ts$/.test(rel) || rel.startsWith("..") || rel.includes("node_modules")) continue;
      const sf = program.getSourceFile(file)!;
      const statements: ast.Node[] = [], expressions: ast.Expression[] = [];
      const visit = (n: ast.Node): void => {
        if (ast.isExpressionStatement(n)) {
          let e = n.expression;
          while (ast.isParenthesizedExpression(e)) e = e.expression;
          const op = ast.isBinaryExpression(e) ? e.operatorToken.kind : undefined;
          const assign = op !== undefined && op >= ast.SyntaxKind.FirstAssignment && op <= ast.SyntaxKind.LastAssignment;
          if (!ast.isAwaitExpression(e) && !ast.isVoidExpression(e) && !assign) {
            statements.push(n);
            expressions.push(e);
          }
        }
        n.forEachChild((c) => void visit(c));
      };
      visit(sf);
      if (!expressions.length) continue;
      checker.getTypeAtLocation(expressions).forEach((t, i) => {
        if (t && thenable(t) && !fromNodeTest(expressions[i]!)) found.push(describeSite(file, sf.text, statements[i]!.pos));
      });
    }
    return found.sort();
  } finally {
    api.close();
  }
}

test("no promise floats unawaited outside the allowlist", () => {
  const allowed = readFileSync(ALLOW, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const left = [...allowed];
  const unexpected: string[] = [];
  for (const f of floatingPromises()) {
    const i = left.indexOf(f);
    if (i >= 0) left.splice(i, 1);
    else unexpected.push(f);
  }
  assert.deepEqual({ unexpected, stale: left }, { unexpected: [], stale: [] }, "await these, write `void` for deliberate fire-and-forget, or list them in test/floating-promises.allow; drop stale entries");
});
