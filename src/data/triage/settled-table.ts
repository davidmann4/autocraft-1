// The settled table `item_settled*`, kept lazily from triggers on `classifications` (M08 triage-a).
//
// `item_settled(run, repo, number, status, label, source, top, jev_label, haiku_label, flags JSON, security, needs_decision,
// referee_*)`: items without a Jev or Haiku verdict have no row ("unclassified"). A run is built in full on first use; after that
// the triggers on `classifications` mark changed items in `item_settled_dirty` and a refresh works out only those again.
import type { Insertable } from "kysely";
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import type { DB } from "../../db/types.ts";
import { runExpr } from "./classify.ts";
import { needsDecisionOf, parseFlags, refereeClosed, securityOf, settle, topOf } from "./settle.ts";

type VerdictRow = { repo: string; number: number; jl: string | null; jf: string | null; probs: string | null; hl: string | null; hf: string | null; sl: string | null; ss: number | null; sr: string | null; sf: number | null; sx: number | null };

/** Items with a Jev or a Haiku verdict in `run` (Haiku alone settles an item when Jev was unavailable), narrowed to `keys` when given. */
function verdictRows(db: Db, run: string, keys?: readonly (readonly [string, number])[]): Promise<VerdictRow[]> {
  const q = queryDb(db);
  // The Sonnet row's probs when they are valid JSON.
  const sp = (eb: kx.AnyEb) => eb.case().when(kx.jsonValid(db, "s.probs")).then(eb.ref("s.probs")).end();
  return q.all(q.k
    .selectFrom((eb) => eb.selectFrom("main.classifications").select(["repo", "number"]).where("run_id", "=", run).where("classifier", "=", "jev")
      .union(eb.selectFrom("main.classifications").select(["repo", "number"]).where("run_id", "=", run).where("classifier", "=", "haiku").where("input_hash", "is not", null))
      .as("k"))
    .leftJoin("main.classifications as j", (j) => j.onRef("j.repo", "=", "k.repo").onRef("j.number", "=", "k.number").on("j.classifier", "=", "jev").on("j.run_id", "=", run))
    .leftJoin("main.classifications as h", (j) => j.onRef("h.repo", "=", "k.repo").onRef("h.number", "=", "k.number").on("h.classifier", "=", "haiku").on("h.run_id", "=", run))
    .leftJoin("main.classifications as s", (j) => j.onRef("s.repo", "=", "k.repo").onRef("s.number", "=", "k.number").on("s.classifier", "=", "sonnet").on("s.run_id", "=", run)
      .onRef("s.at", ">=", "j.at").onRef("s.at", ">=", "h.at").on((eb) => eb(kx.jsonBool(db, sp(eb), "$.sure"), "is not", null)))
    .select(["k.repo", "k.number", "j.type_label as jl", "j.flags as jf", "j.probs", "h.type_label as hl", "h.flags as hf", "s.type_label as sl", "s.reason as sr"])
    .select((eb) => [kx.jsonBool(db, sp(eb), "$.sure").as("ss"), kx.jsonBool(db, sp(eb), "$.final").as("sf"), kx.jsonNum(db, sp(eb), "$.opusFailures").as("sx")])
    .$if(!!keys, (b) => b.where(kx.refIn(db, "k", keys!))), { label: "triage.verdictRows" }) as Promise<VerdictRow[]>;
}

const SETTLED_COLS = {
  run: "text", repo: "text", number: "bigint", status: "text", label: "text", source: "text", top: "numeric", jev_label: "text", haiku_label: "text", flags: "text",
  security: "bigint", needs_decision: "bigint", referee_label: "text", referee_sure: "bigint", referee_reason: "text", referee_final: "bigint",
} as const satisfies Record<string, kx.ElemType>;

/**
 * The current run with its built and dirty state in one statement; stale means one `db.write` that builds or refreshes the
 * table. A no-op inside `db.read` (a snapshot sees the table as the last refresh left it): call it before the read.
 */
export async function currentRunReady(db: Db): Promise<string | null> {
  const q = queryDb(db);
  const row = await q.get(q.k.selectFrom((q.k as any).selectNoFrom((eb: kx.AnyEb) => runExpr(eb).as("run")).as("r")).select((eb: kx.AnyEb) => [
    eb.ref("r.run").as("run"),
    eb.exists(kx.schemaEb(eb).selectFrom("main.item_settled_runs as sr").select(eb.lit(1).as("one")).whereRef("sr.run", "=", "r.run" as never)).as("built"),
    eb.exists(kx.schemaEb(eb).selectFrom("main.item_settled_dirty as sd").select(eb.lit(1).as("one")).whereRef("sd.run_id", "=", "r.run" as never)).as("dirty"),
  ]) as any, { label: "triage.currentRunReady" }) as { run: string | null; built: unknown; dirty: unknown } | undefined;
  const run = row?.run ?? null;
  if (run === null) return null;
  if (row!.built && !row!.dirty) return run;
  await refresh(db, run);
  return run;
}

/** The same for a caller that already has a run (the Items page's `?run=`). */
export async function ensureSettled(db: Db, run: string | null): Promise<void> {
  if (run === null) return;
  const q = queryDb(db);
  const r = (await q.get(q.k.selectNoFrom((eb) => [
    eb.exists(eb.selectFrom("main.item_settled_runs").select(eb.lit(1).as("one")).where("run", "=", run)).as("built"),
    eb.exists(eb.selectFrom("main.item_settled_dirty").select(eb.lit(1).as("one")).where("run_id", "=", run)).as("dirty"),
  ]), { label: "triage.ensureSettled" }))!;
  if (r.built && !r.dirty) return;
  await refresh(db, run);
}

async function refresh(db: Db, run: string): Promise<void> {
  if (db.inTransaction("read")) return;
  await db.write(() => refreshSettled(db, run));
}

async function refreshSettled(db: Db, run: string): Promise<void> {
  const q = queryDb(db);
  const built = !!await q.get(q.k.selectFrom("main.item_settled_runs").select((eb) => eb.lit(1).as("one")).where("run", "=", run));
  const rows: Insertable<DB["main.item_settled"]>[] = [];
  const put = (r: VerdictRow) => {
    const ref = r.sl !== null && r.ss !== null ? { label: r.sl, sure: !!r.ss, reason: r.sr ?? "", ...(r.sf ? { final: true } : {}), ...(r.sx ? { failures: r.sx } : {}) } : null;
    const s = settle(r.jl === null ? null : { label: r.jl, flags: parseFlags(r.jf), top: topOf(r.probs), nd: needsDecisionOf(r.probs), sec: securityOf(r.probs) }, r.hl === null ? null : { label: r.hl, flags: parseFlags(r.hf) }, ref);
    rows.push({
      run, repo: r.repo, number: r.number, status: s.status, label: s.label, source: s.source, top: s.confidence, jev_label: s.jevLabel, haiku_label: s.haikuLabel,
      flags: JSON.stringify(s.flags), security: s.flags.includes("security") ? 1 : 0, needs_decision: s.flags.includes("needs decision") ? 1 : 0,
      referee_label: s.referee?.label ?? null, referee_sure: s.referee ? Number(s.referee.sure) : null, referee_reason: s.referee?.reason ?? null, referee_final: refereeClosed(s.referee) ? 1 : 0,
    });
  };
  if (!built) {
    // Marks made before this read are covered by it; marks committed after it stay for the next refresh.
    await q.run(q.k.deleteFrom("main.item_settled_dirty").where("run_id", "=", run));
    await q.run(q.k.deleteFrom("main.item_settled").where("run", "=", run));
    for (const r of await verdictRows(db, run)) put(r);
    // Built runs whose classifications are all gone.
    const gone = (eb: kx.AnyEb) => eb.selectFrom("main.item_settled_runs as r").select("r.run").where("r.run", "<>", run)
      .where((e) => e.not(e.exists(e.selectFrom("main.classifications as c").select(e.lit(1).as("one")).whereRef("c.run_id", "=", "r.run"))));
    await q.run(q.k.deleteFrom("main.item_settled").where("run", "in", gone));
    await q.run(q.k.deleteFrom("main.item_settled_runs").where("run", "in", gone));
  } else {
    const dirty = await q.all(q.k.selectFrom("main.item_settled_dirty").select(["repo", "number", "n"]).where("run_id", "=", run));
    if (!dirty.length) return;
    for (const part of kx.chunks(dirty)) {
      const keys = part.map((k) => [k.repo, k.number] as const);
      await q.run(q.k.deleteFrom("main.item_settled").where("run", "=", run).where(kx.refIn(db, "main.item_settled", keys)));
      for (const r of await verdictRows(db, run, keys)) put(r);
      // Only the marks read above: an item marked again since then (n moved) stays marked.
      await q.run(q.k.deleteFrom("main.item_settled_dirty").where("run_id", "=", run)
        .where(kx.tupleIn(db, ["repo", "number", "n"], part.map((k) => [k.repo, k.number, k.n]), ["text", "bigint", "bigint"])));
    }
  }
  // Marks of runs that are not built: a run is built in full on first use. This run's are kept, built or not: a mark
  // committed during a first build covers a change that build may not have read.
  await q.run(q.k.deleteFrom("main.item_settled_dirty").where("run_id", "<>", run)
    .where("run_id", "not in", (eb) => eb.selectFrom("main.item_settled_runs").select("run")));
  const cols = Object.keys(SETTLED_COLS) as (keyof typeof SETTLED_COLS)[];
  for (const part of kx.chunks(rows)) {
    const v = kx.valuesTable(db, part as Record<string, string | number | null>[], SETTLED_COLS, "v");
    await q.run(q.k.insertInto("main.item_settled").columns(cols).expression((eb) => eb.selectFrom(v).select(cols.map((c) => `v.${c}` as const))));
  }
  await q.run(q.k.insertInto("main.item_settled_runs").values({ run, refreshed_at: new Date().toISOString() })
    .onConflict((oc) => oc.column("run").doUpdateSet(kx.excluded(["refreshed_at"]))));
}
