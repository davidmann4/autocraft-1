// Read models for the dashboard, MCP and status (M09 triage-b).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import * as control from "../control/fragments.ts";
import { loadItemAreas } from "./areas.ts";
import { loadLatestVerdicts, loadSettled } from "./classify.ts";
import { classifierPairRows } from "./cross.ts";
import { loadDupeSignals } from "./dupes.ts";
import { loadPriorities } from "./priority.ts";
import { loadRanks } from "./rank.ts";
import type { ClassifierReport, ClassifierReportFilter, ClassifierRun, DisagreementFilter, DisagreementList, ItemTriage } from "./types.ts";
import type { HiddenRepos } from "../control/types.ts";

const onKey = (j: any) => j.onRef("y.run_id", "=", "x.run_id").onRef("y.repo", "=", "x.repo").onRef("y.number", "=", "x.number");

/**
 * The runs with their classifier pairs and, for the chosen run and pair, the items both rated. Two waves: the run and pair lists
 * (two statements), then the pair's rows, which depend on the choice. The newest run and its first pair stand when `run`, `a` and `b` name none.
 */
export async function loadClassifierReport(db: Db, f: ClassifierReportFilter): Promise<ClassifierReport> {
  const q = queryDb(db), k = q.k as any;
  const [withProbs, pairs] = await db.together(() => Promise.all([
    q.all(k.selectFrom("classifications").select(["run_id", "classifier", (eb: any) => eb.fn.count("probs").as("p")]).groupBy(["run_id", "classifier"])) as Promise<{ run_id: string; classifier: string; p: number | string }[]>,
    q.all(k.selectFrom("classifications as x").innerJoin("classifications as y", (j: any) => onKey(j).onRef("y.classifier", ">", "x.classifier"))
      .select(["x.run_id as run", "x.classifier as x", "y.classifier as y", (eb: any) => eb.fn.countAll().as("n"), (eb: any) => eb.fn.max("x.at").as("at")])
      .where(control.hiddenRepos(db, "x.repo", f.hidden))
      .groupBy(["x.run_id", "x.classifier", "y.classifier"]).orderBy("x.run_id").orderBy("x.classifier").orderBy("y.classifier")) as Promise<{ run: string; x: string; y: string; n: number | string; at: string }[]>,
  ]));
  const prob = new Map(withProbs.map((r) => [`${r.run_id}\0${r.classifier}`, Number(r.p) > 0]));
  const by = new Map<string, ClassifierRun>();
  for (const p of pairs) {
    let r = by.get(p.run);
    if (!r) by.set(p.run, (r = { id: p.run, at: p.at, pairs: [] }));
    if (p.at > r.at) r.at = p.at;
    // The classifier with probabilities goes first, so bands describe it.
    const swap = !prob.get(`${p.run}\0${p.x}`) && !!prob.get(`${p.run}\0${p.y}`);
    r.pairs.push(swap ? { a: p.y, b: p.x, items: Number(p.n) } : { a: p.x, b: p.y, items: Number(p.n) });
  }
  for (const r of by.values()) r.pairs.sort((u, v) => v.items - u.items || u.a.localeCompare(v.a));
  const runs = [...by.values()].sort((u, v) => v.at.localeCompare(u.at));
  const run = runs.find((r) => r.id === f.run) ?? runs[0];
  if (!run) return { runs: [], run: "", a: "", b: "", rows: [] };
  const pair = run.pairs.find((p) => p.a === f.a && p.b === f.b) ?? run.pairs.find((p) => p.a === f.b && p.b === f.a) ?? run.pairs[0]!;
  return { runs, run: run.id, a: pair.a, b: pair.b, rows: await classifierPairRows(db, run.id, pair.a, pair.b, f.hidden) };
}

/** The items two classifiers rated differently in a run, with their probabilities: total and page in one wave. The item rows come from the mirror in the view. */
export async function listDisagreements(db: Db, f: DisagreementFilter): Promise<DisagreementList> {
  const q = queryDb(db), k = q.k as any;
  const top = (alias: string) => kx.jsonNum(db, `${alias}.probs`, "$.top");
  const from = () => k.selectFrom("classifications as x").innerJoin("classifications as y", (j: any) => onKey(j).on("y.classifier", "=", f.b))
    .where((eb: any) => eb.and([
      eb("x.run_id", "=", f.run), eb("x.classifier", "=", f.a), eb("x.type_label", "is not", null), eb("y.type_label", "is not", null), eb("x.type_label", "<>", eb.ref("y.type_label")),
      control.hiddenRepos(db, "x.repo", f.hidden),
      ...(f.label ? [eb.or([eb("x.type_label", "=", f.label), eb("y.type_label", "=", f.label)])] : []),
      ...(f.band ? [eb.and([eb(top("x"), ">=", f.band.lo), eb(top("x"), "<", f.band.hi)])] : []),
    ]));
  const [total, rows] = await db.together(() => Promise.all([
    q.get(from().select((eb: any) => eb.fn.countAll().as("n"))) as Promise<{ n: number | string }>,
    q.all(from().select(["x.repo", "x.number", "x.type_label as la", "y.type_label as lb", top("x").as("pa"), top("y").as("pb")]).orderBy("x.repo").orderBy("x.number").limit(f.limit).offset(f.offset)) as Promise<
      { repo: string; number: number; la: string; lb: string; pa: number | string | null; pb: number | string | null }[]>,
  ]));
  const num = (v: number | string | null): number | null => (v === null ? null : Number(v));
  return {
    total: Number(total.n),
    rows: rows.map((r) => ({ repo: r.repo, number: Number(r.number), a: { label: r.la, prob: num(r.pa) }, b: { label: r.lb, prob: num(r.pb) } })),
  };
}

/** Distinct items with a verdict in the run (all runs without `run`), newer than `since` when given; `hidden` leaves out the viewer's hidden repos. */
export async function loadClassifiedCount(db: Db, f: { run?: string; since?: string; hidden?: HiddenRepos }): Promise<number> {
  const q = queryDb(db), k = q.k as any;
  const r = (await q.get(k.selectFrom((eb: any) => eb.selectFrom("classifications as c").select(["c.repo", "c.number"]).distinct()
    .$if(!!f.run, (b: any) => b.where("c.run_id", "=", f.run!)).$if(!!f.since, (b: any) => b.where("c.at", ">=", f.since!))
    .$if(!!f.hidden, (b: any) => b.where(control.hiddenRepos(db, "c.repo", f.hidden!))).as("m"))
    .select((eb: any) => eb.fn.countAll().as("n")))) as { n: number | string };
  return Number(r.n);
}

/** The item page's verdicts, settled label, priority, area, rank and duplicate signal in one wave. */
export async function loadItemTriage(db: Db, ref: { repo: string; number: number }, run: string | null): Promise<ItemTriage> {
  const keys = [{ repo: ref.repo, number: ref.number }];
  const key = `${ref.repo}#${ref.number}`;
  const [verdicts, settled, priority, area, rank, dupe] = await db.together(() => Promise.all([
    loadLatestVerdicts(db, keys), loadSettled(db, keys, run), loadPriorities(db, keys), loadItemAreas(db, keys), loadRanks(db, keys), loadDupeSignals(db, keys),
  ]));
  return { verdicts: verdicts.get(key) ?? [], settled: settled.get(key) ?? null, priority: priority.get(key) ?? null, area: area.get(key) ?? null, rank: rank.get(key) ?? null, dupe: dupe.get(key) ?? null };
}

/** Count and newest time of the item's verdicts, for the page fingerprint. */
export async function loadVerdictStamp(db: Db, ref: { repo: string; number: number }): Promise<{ n: number; newest: string | null }> {
  const q = queryDb(db), k = q.k as any;
  const r = (await q.get(k.selectFrom("classifications").select((eb: any) => [eb.fn.countAll().as("n"), eb.fn.max("at").as("newest")])
    .where("repo", "=", ref.repo).where("number", "=", ref.number))) as { n: number | string; newest: string | null };
  return { n: Number(r.n), newest: r.newest };
}
