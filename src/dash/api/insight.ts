// Read-only insight endpoints: classifier agreement per run, and token use and spend.
import type {
  Agreement, ClassifierReport, CostReport, Disagreement, DisagreementList, FlagAgreement,
} from "../../../web/src/api/types.ts";
import * as inference from "../../data/inference/index.ts";
import * as mirror from "../../data/mirror/index.ts";
import * as triage from "../../data/triage/index.ts";
import { BANDS, bandIndex } from "../../classify/report.ts";
import { LABELS } from "../../classify/rules.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { canSeeInternals } from "./staff.ts";
import { hiddenRepos } from "./visible.ts";
import type { Db } from "../../db/index.ts";

const FLAGS = ["security", "needs decision"];

// ---- classifiers -------------------------------------------------------------

const agr = (): Agreement => ({ n: 0, agree: 0 });
const tally = (g: Agreement, same: boolean) => { g.n++; if (same) g.agree++; };

function flagsOf(s: string | null): string[] {
  try {
    const v = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

export async function classifiersReport(db: Db, req: Req): Promise<ClassifierReport> {
  const hidden = await hiddenRepos(db, req);
  const { runs: all, run: runId, a, b, rows } = await triage.loadClassifierReport(db, { run: req.query.get("run") ?? undefined, a: req.query.get("a") ?? undefined, b: req.query.get("b") ?? undefined, hidden });
  if (!all.length) return { runs: [], run: "", a: "", b: "", labels: [...LABELS], items: 0, overall: agr(), byKind: { pr: agr(), issue: agr() }, byLabel: [], byRepo: [], confusion: [], bands: [], flags: [] };
  const pair = { a, b };
  const run = { id: runId };
  const idx = new Map<string, number>(LABELS.map((l, i) => [l, i]));
  const overall = agr(), kind = { pr: agr(), issue: agr() };
  const byLabel = new Map<string, Agreement>(), byRepo = new Map<string, Agreement>();
  const confusion = LABELS.map(() => LABELS.map(() => 0));
  const bandN = BANDS.map(agr);
  const flags = FLAGS.map((flag): FlagAgreement => ({ flag, n: 0, agree: 0, both: 0, onlyA: 0, onlyB: 0 }));
  for (const r of rows) {
    const same = r.ta === r.tb;
    if (r.ta && r.tb) {
      tally(overall, same);
      if (r.kind === "pr" || r.kind === "issue") tally(kind[r.kind], same);
      tally(byLabel.get(r.ta) ?? byLabel.set(r.ta, agr()).get(r.ta)!, same);
      tally(byRepo.get(r.repo) ?? byRepo.set(r.repo, agr()).get(r.repo)!, same);
      const i = idx.get(r.ta), j = idx.get(r.tb);
      if (i !== undefined && j !== undefined) confusion[i]![j]!++;
      if (r.pa !== null) tally(bandN[bandIndex(r.pa)]!, same);
    }
    const fa = flagsOf(r.fa), fb = flagsOf(r.fb);
    flags.forEach((f) => {
      const x = fa.includes(f.flag), y = fb.includes(f.flag);
      f.n++;
      if (x === y) f.agree++;
      if (x && y) f.both++;
      else if (x) f.onlyA++;
      else if (y) f.onlyB++;
    });
  }
  let cumN = 0, cumAgree = 0;
  const bands = bandN.map((b, i) => {
    cumN += b.n;
    cumAgree += b.agree;
    return { band: BANDS[i]!.band, ...b, cumN, cumAgree };
  });
  const known = bandN.some((b) => b.n > 0);
  return {
    runs: all, run: run.id, a: pair.a, b: pair.b, labels: [...LABELS], items: rows.length, overall, byKind: kind,
    byLabel: LABELS.map((label) => ({ label, ...(byLabel.get(label) ?? agr()) })),
    byRepo: [...byRepo].map(([repo, v]) => ({ repo, ...v })).sort((u, v) => v.n - u.n),
    confusion, bands: known ? bands : [], flags,
  };
}

export async function disagreements(db: Db, req: Req): Promise<DisagreementList> {
  const run = req.query.get("run") ?? "", a = req.query.get("a") ?? "", b = req.query.get("b") ?? "";
  const hidden = await hiddenRepos(db, req);
  const label = req.query.get("label");
  const bandName = req.query.get("band");
  let band: { lo: number; hi: number } | undefined;
  if (bandName) {
    const bd = BANDS.find((x) => x.band === bandName);
    if (!bd) throw new HttpError(400, "unknown band");
    band = { lo: Number.isFinite(bd.lo) ? bd.lo : -1, hi: Number.isFinite(bd.hi) ? bd.hi : 2 };
  }
  const limit = Math.min(200, Math.max(1, Math.floor(Number(req.query.get("limit"))) || 50));
  const offset = Math.min(1_000_000, Math.max(0, Math.floor(Number(req.query.get("offset"))) || 0));
  const page = await triage.listDisagreements(db, { run, a, b, ...(label ? { label } : {}), ...(band ? { band } : {}), hidden, limit, offset });
  const shown = await mirror.loadShown(db, page.rows.map((r) => ({ repo: r.repo, number: r.number })));
  return {
    total: page.total,
    rows: page.rows.map((r): Disagreement => {
      const it = shown.get(`${r.repo}#${r.number}`);
      return { repo: r.repo, number: r.number, kind: it?.kind ?? "issue", state: it ? it.state : null, title: it?.title ?? "", a: r.a, b: r.b };
    }),
  };
}

// ---- run and cost ------------------------------------------------------------

export async function cost(db: Db, req: Req): Promise<CostReport> {
  const run = req.query.get("run") ?? "";
  const hidden = await hiddenRepos(db, req);
  // Per-user usage is for staff. Under a repo filter a run counts only when it has items and all of them are visible.
  const [usage, itemsClassified] = await db.together(() => Promise.all([
    inference.loadUsageReport(db, { run, vis: { hidden, staff: canSeeInternals(req) } }),
    triage.loadClassifiedCount(db, { ...(run ? { run } : {}), hidden }),
  ]));
  return { ...usage, itemsClassified };
}
