// Which labels each open item should get. Reads the mirror and classifications only.
import { forRun, settleRows, type ClsRow } from "./settled.ts";
import { isTypeLabel, sameLabel } from "./set.ts";
import { listItems } from "../data/mirror/index.ts";
import type { ItemOf } from "../data/mirror/types.ts";
import { loadOwnIntegration } from "../data/merge/index.ts";
import { listQuietPrs } from "../data/security/index.ts";
import { loadLabelVerdicts } from "../data/triage/index.ts";
import type { Db } from "../db/index.ts";

export type PlanStatus = "add" | "already" | "unsettled" | "conflict";
export type PlanRow = {
  number: number; kind: string; url: string; status: PlanStatus;
  settled: string; existing: string[]; add: string[]; note: string;
};
export type PlanCounts = { toAdd: number; already: number; unsettled: number; conflicts: number };

export const planLabels = async (db: Db, repo: string, runId?: string): Promise<PlanRow[]> => (await planLabelsOf(db, [repo], runId)).get(repo) ?? [];

/** The plan of each repo, in one wave. */
export async function planLabelsOf(db: Db, repos: string[], runId?: string): Promise<Map<string, PlanRow[]>> {
  const [listed, own, quiet, cls] = await db.together(() => Promise.all([
    listItems(db, { repos, states: ["OPEN"], inScope: true }, "labels"), loadOwnIntegration(db, repos), listQuietPrs(db), loadLabelVerdicts(db, repos, runId),
  ]));
  const out = new Map<string, PlanRow[]>();
  for (const it of listed) {
    if (own.has(`${it.repo}#${it.number}`)) continue;
    (out.get(it.repo) ?? out.set(it.repo, []).get(it.repo)!).push(planOf(it, cls.get(`${it.repo}#${it.number}`) ?? [], quiet, runId));
  }
  return out;
}

function planOf(it: ItemOf<"labels">, rows: ClsRow[], quiet: ReadonlySet<string>, runId: string | undefined): PlanRow {
  let existing: string[] = [];
  try {
    existing = (JSON.parse(it.labels ?? "[]") as unknown[]).map(String);
  } catch { /* unreadable labels count as none */ }
  const row = { number: it.number, kind: it.kind, url: it.url ?? "", settled: "", existing, add: [] as string[], note: "" };
  const settled = settleRows(forRun(rows, runId));
  const s = settled && quiet.has(`${it.repo}#${it.number}`) ? { ...settled, security: false } : settled;
  if (!s) return { ...row, status: "unsettled" as const };
  row.settled = s.type;
  const other = existing.filter((l) => isTypeLabel(l) && !sameLabel(l, s.type));
  if (other.length) return { ...row, status: "conflict" as const, note: `has ${other.join(", ")}` };
  const want = [s.type, ...(s.security ? ["security"] : []), ...(s.needsDecision ? ["needs decision"] : [])];
  const add = want.filter((w) => !existing.some((e) => sameLabel(e, w)));
  return { ...row, add, status: add.length ? ("add" as const) : ("already" as const) };
}

export function countPlan(rows: PlanRow[]): PlanCounts {
  const n = (s: PlanStatus) => rows.filter((r) => r.status === s).length;
  return { toAdd: n("add"), already: n("already"), unsettled: n("unsettled"), conflicts: n("conflict") };
}

const csvCell = (s: string | number) => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
export function planCsv(repo: string, rows: PlanRow[]): string {
  const lines = [["repo", "number", "kind", "status", "settled_type", "existing_labels", "labels_to_add", "note", "url"].join(",")];
  for (const r of rows) lines.push([repo, r.number, r.kind, r.status, r.settled, r.existing.join("|"), r.add.join("|"), r.note, r.url].map(csvCell).join(","));
  return lines.join("\n") + "\n";
}
