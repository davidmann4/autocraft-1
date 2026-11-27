// Quiet pull requests (`security_quiet_prs`) (package security).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { quietPrExpr } from "./fragments.ts";
import type { Ref } from "./types.ts";

/** Finding states after which a closed quiet pull request is no longer quiet. */
const FORMER_CLOSED = ["published", "dismissed"];

/** The refs among the input that are quiet PRs. 1 statement. */
export async function loadQuiet(db: Db, refs: Ref[]): Promise<Set<Ref>> {
  if (refs.length === 0) return new Set();
  const q = queryDb(db);
  const out = new Set<Ref>();
  for (const chunk of kx.chunks(refs)) {
    for (const r of await q.all(q.k.selectFrom(kx.refPairs(db, chunk, "rp")).select(["rp.repo", "rp.number"]).where((eb) => quietPrExpr(eb, "rp.repo", "rp.number")))) out.add(`${r.repo}#${r.number}`);
  }
  return out;
}

/** All quiet PRs, optionally of one repo: findings landing or landed by the quiet route, and closed quiet PRs whose finding is not yet published or dismissed. 1 statement. */
export async function listQuietPrs(db: Db, f?: { repo?: string }): Promise<Set<Ref>> {
  const q = queryDb(db);
  const open = q.k.selectFrom("main.security_findings as qf").select(["qf.repo as repo", "qf.fix_pr as pr"]).$narrowType<{ pr: number }>()
    .where("qf.state", "in", ["landing", "landed"]).where("qf.fork", "is", null).where("qf.fix_pr", "is not", null).$if(!!f?.repo, (b) => b.where("qf.repo", "=", f!.repo!));
  const former = q.k.selectFrom("main.security_quiet_prs as qp").innerJoin("main.security_findings as qg", (j) => j.onRef("qg.repo", "=", "qp.repo").onRef("qg.number", "=", "qp.finding"))
    .select(["qp.repo as repo", "qp.pr as pr"]).where("qg.state", "not in", FORMER_CLOSED).$if(!!f?.repo, (b) => b.where("qp.repo", "=", f!.repo!));
  const rows = await q.all(open.unionAll(former));
  return new Set(rows.map((r) => `${r.repo}#${r.pr}`));
}

/** Remembers PRs as the quiet PR of a finding; called in the transaction that clears `fix_pr`. */
export async function addQuietPrs(db: Db, rows: { repo: string; pr: number; finding: number }[]): Promise<void> {
  if (rows.length === 0) return;
  const q = queryDb(db);
  await db.write(async () => {
    for (const chunk of kx.batches(rows)) await q.run(q.k.insertInto("main.security_quiet_prs").values(chunk).onConflict((oc) => oc.doNothing()));
  });
}
