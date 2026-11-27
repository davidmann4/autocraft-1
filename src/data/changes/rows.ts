// Row shapes and mappers shared by the loaders of this module (internal; not exported from index.ts).
import { queryDb } from "../../db/query-db.ts";
import type { Db } from "../../db/index.ts";
import type { Compilable } from "kysely";
import type { CifixRow, ConflictRow, FixupRow, FixupSource, ModelCheckRow, PatchCheckRow, PushEdge, RefKey } from "./types.ts";

export const refKey = (repo: string, number: number): RefKey => `${repo}#${number}`;
export const splitRef = (ref: RefKey): [string, number] => { const i = ref.lastIndexOf("#"); return [ref.slice(0, i), Number(ref.slice(i + 1))]; };
export const push = <K, V>(m: Map<K, V[]>, k: K, v: V): void => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };

/** Runs a Kysely select whose row type the caller states (the tables are named through string aliases). */
export const rowsOf = <T>(db: Db, q: unknown): Promise<T[]> => queryDb(db).all(q as Compilable<T>);

export const strings = (json: string | null | undefined): string[] => {
  try { const v = JSON.parse(json ?? "[]") as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
};
export const numbers = (json: string | null | undefined): number[] | null => {
  if (json === null || json === undefined) return null;
  try { const v = JSON.parse(json) as unknown; return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : null; } catch { return null; }
};
export const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Join condition of a statement's table alias to a `resolveKeys(.., "kk")` expression. */
export const onKey = (alias: string) => (j: any) => j.onRef("kk.repo", "=", `${alias}.repo`).onRef("kk.number", "=", `${alias}.number`);

type Raw = Record<string, any>;

export const fixupRow = (r: Raw): FixupRow => ({
  id: Number(r.id), repo: r.repo, number: Number(r.number), createdAt: r.created_at, fromHead: r.from_head, toHead: r.to_head, state: r.state, reason: r.reason,
  source: (r.source ?? null) as FixupSource | null, attempt: Number(r.attempt), lintTask: num(r.lint_task), lintState: r.lint_state ?? null, operatorFix: num(r.operator_fix),
});
export const cifixRow = (r: Raw): CifixRow => ({
  id: Number(r.id), repo: r.repo, number: Number(r.number), createdAt: r.created_at, head: r.head, toHead: r.to_head, kind: r.kind, state: r.state, reason: r.reason,
  files: strings(r.files), attempt: Number(r.attempt), taskId: num(r.task_id), lintTask: num(r.lint_task), runs: numbers(r.runs),
});
export const conflictRow = (r: Raw): ConflictRow => ({
  id: Number(r.id), repo: r.repo, number: Number(r.number), createdAt: r.created_at, fromHead: r.from_head, toHead: r.to_head, baseSha: r.base_sha, state: r.state, reason: r.reason,
  attempt: Number(r.attempt), lintTask: num(r.lint_task), ownDiff: r.own_diff ?? null,
});

export const fixupEdge = (r: Raw): PushEdge => ({
  kind: "fixup", id: Number(r.id), from: r.from_head, to: r.to_head, state: r.state, source: (r.source ?? null) as FixupSource | null, reason: r.reason, at: r.created_at,
});
export const cifixEdge = (r: Raw): PushEdge => ({
  kind: "cifix", id: Number(r.id), from: r.head, to: r.to_head, state: r.state, source: null, ciKind: r.kind, reason: r.reason, at: r.created_at,
});
export const conflictEdge = (r: Raw): PushEdge => ({
  kind: "conflict", id: Number(r.id), from: r.from_head, to: r.to_head, state: r.state, source: null, ownDiff: r.own_diff ?? null, reason: r.reason, at: r.created_at,
});

/** Newest first by (created, id), the order `PatchFacts.pushes` has. */
export const newestFirst = (edges: PushEdge[]): PushEdge[] => edges.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id));

/** Edge states: a fix-up or CI fix that moved the head is `pushing` or `pushed`; a conflict merge is `merged` or `pushing`. */
export const FIXUP_EDGE_STATES = ["pushing", "pushed"];
export const CONFLICT_EDGE_STATES = ["pushing", "merged"];

export const noKeys = (keys: unknown): boolean => Array.isArray(keys) && keys.length === 0;

export const MODEL_CHECK_COLS = ["m.id", "m.run_id", "m.step", "m.repo", "m.number", "m.head", "m.command", "m.crate", "m.test_name", "m.task_id", "m.outcome", "m.started_at", "m.ended_at"] as const;
export const modelCheckRow = (r: Raw): ModelCheckRow => ({
  id: Number(r.id), runId: num(r.run_id), step: r.step, repo: r.repo, number: num(r.number), head: r.head, command: r.command, crate: r.crate ?? null, testName: r.test_name ?? null,
  taskId: num(r.task_id), outcome: r.outcome ?? null, startedAt: r.started_at, endedAt: r.ended_at ?? null,
});
export const PATCH_CHECK_COLS = ["p.id", "p.kind", "p.repo", "p.number", "p.subject", "p.patch_hash", "p.round", "p.verdict", "p.reasons", "p.problems", "p.model", "p.created_at"] as const;
export const patchCheckRow = (r: Raw): PatchCheckRow => ({
  id: Number(r.id), kind: r.kind, repo: r.repo, number: Number(r.number), subject: r.subject, patchHash: r.patch_hash, round: Number(r.round), verdict: r.verdict, reasons: r.reasons,
  problems: strings(r.problems), model: r.model, createdAt: r.created_at,
});
