// The stored link between an implement workflow and its PR (item_workflows.pr_number): its writer at every event, its readers with and without
// it, and both against the rules it stands for (test/legacy-link.ts) (SQLite; Postgres when AUTOCRAFT_TEST_PG_URL is set).
import assert from "node:assert/strict";
import { sql } from "kysely";
import type { Db } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import * as kx from "../../src/db/kx.ts";
import { addTrackedRepo } from "../../src/data/control/index.ts";
import { loadImplementFacts } from "../../src/data/implement/index.ts";
import { startedWorkAllows } from "../../src/data/runners/cross.ts";
import { loadRunnerSnapshot } from "../../src/data/runners/index.ts";
import { startedOf, tierTokens } from "../../src/remote/started.ts";
import type { Tier } from "../../src/remote/protocol.ts";
import { parseStatus, storeStatus } from "../../src/remote/helpers.ts";
import { createToken } from "../../src/dash/mcp/tokens.ts";
import { liveWorkflowExpr, worksOnPr } from "../../src/data/workflow/fragments.ts";
import {
  linkWorkflows, listWorkflows, loadEndedWorkflows, releaseItemRunner, takeItemRunner, loadInScope, loadLinks, loadPrWorkflows, loadStartedRefs, loadStartedWork, loadWorkflowFacts, loadWorkScores, moveWorkflows, saveWorkflows, startWorkflows,
  type WorkflowState,
} from "../../src/data/workflow/index.ts";
import { workOf } from "../../src/workflow/work.ts";
import { expectFlat } from "../helpers/query-count.ts";
import * as legacy from "../legacy-link.ts";
import { prng } from "../random-pr.ts";
import { both, openApp } from "./planner-helpers.ts";

/** Minute `m` of the tests' day. */
const at = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m)).toISOString();
const REPO = "o/a";
const issue = (number: number) => ({ repo: REPO, number });
const start = (number: number, m: number) => ({ repo: REPO, number, kind: "issue" as const, entry: "implement" as const, weight: 5, startedBy: "ann", startedVia: "cli" as const, at: at(m) });

type AttemptIn = { number: number; state?: string; made: number; moved?: number; pr?: number | null };
/** Rows as the implement module and the sync write them, straight into the tables. */
const rows = (db: Db) => {
  const q = queryDb(db), k = q.k as any;
  let tries = 0;
  return {
    attempt: async (a: AttemptIn): Promise<number> => Number(((await q.all(k.insertInto("main.implementations").values({
      repo: REPO, number: a.number, queued_by: "ann", state: a.state ?? "opening", attempt: ++tries, text_hash: "h", pr_number: a.pr ?? null, created_at: at(a.made), updated_at: at(a.moved ?? a.made),
    }).returning("id"))) as { id: number | string }[])[0]!.id),
    /** The attempt's step: what openImplementationPr and the advance pass write. */
    move: (id: number, m: number, set: { state?: string; pr_number?: number }) => q.run(k.updateTable("main.implementations").set({ ...set, updated_at: at(m) }).where("id", "=", id)),
    pr: async (number: number, state: "OPEN" | "CLOSED" | "MERGED" = "OPEN", closed: number | null = null) => {
      await q.run(k.insertInto("main.items").values({ repo: REPO, number, kind: "pr", state, closed_at: closed === null ? null : at(closed) })
        .onConflict((oc: any) => oc.columns(["repo", "number"]).doUpdateSet({ state, closed_at: closed === null ? null : at(closed) })));
    },
    /** A workflow as a writer that does not know the column makes it. */
    unlinked: async (number: number, m: number, state: WorkflowState = "running"): Promise<number> => Number(((await q.all(k.insertInto("main.item_workflows").values({
      repo: REPO, number, kind: "issue", entry: "implement", weight: 5, state, started_by: "ann", started_at: at(m), started_via: "cli", plan: "[]", updated_at: at(m),
    }).returning("id"))) as { id: number | string }[])[0]!.id),
    stored: async (id: number): Promise<number | null> => (await listWorkflows(db, { ids: [id] }))[0]!.prNumber,
  };
};
const startOne = async (db: Db, number: number, m: number): Promise<number> => (await startWorkflows(db, [start(number, m)])).get(`${REPO}#${number}`)!;
const end = (db: Db, id: number, m: number, state: WorkflowState = "stopped") => saveWorkflows(db, [{ id, patch: { state }, at: at(m) }]);
const links = async (db: Db, number: number, o: { ended?: true } = {}) => (await loadLinks(db, { issues: [issue(number)] }, o)).map((l) => [l.workflowId, l.pr] as const);

both("opening a PR links the issue's live workflow and nothing else of it: a command that read the workflow before still applies, and a second run writes nothing", async ({ db }) => {
  const r = rows(db);
  const w = await startOne(db, 1, 10);
  const before = (await listWorkflows(db, { ids: [w] }))[0]!;
  assert.deepEqual(await links(db, 1), []);
  const i = await r.attempt({ number: 1, made: 11 });
  assert.deepEqual(await linkWorkflows(db), [], "an attempt without a PR");
  await r.pr(100);
  await r.move(i, 12, { pr_number: 100 });
  assert.deepEqual(await linkWorkflows(db, { issues: [issue(2)] }), []);
  assert.deepEqual(await linkWorkflows(db, { issues: [issue(1)] }), [{ workflowId: w, repo: REPO, issue: 1, pr: 100, live: true }]);
  assert.deepEqual(await linkWorkflows(db), []);
  const after = (await listWorkflows(db, { ids: [w] }))[0]!;
  assert.deepEqual(after, { ...before, prNumber: 100 });
  assert.equal((await moveWorkflows(db, [{ id: w, patch: { state: "waiting" }, at: at(13), was: { state: before.state, updatedAt: before.updatedAt, version: before.version } }])).size, 1);
  // Two writers with the same reading: one writes.
  await queryDb(db).run((queryDb(db).k as any).updateTable("main.item_workflows").set({ pr_number: null }).where("id", "=", w));
  const both2 = await Promise.all([linkWorkflows(db), linkWorkflows(db)]);
  assert.equal(await r.stored(w), 100);
  assert.ok(both2.flat().length >= 1);
});

both("without a live workflow the newest ended one takes the PR an attempt opens, whatever it was linked to before", async ({ db }) => {
  const r = rows(db);
  const w = await startOne(db, 1, 10);
  const i = await r.attempt({ number: 1, made: 11, pr: 100 });
  await r.pr(100);
  await linkWorkflows(db);
  await r.move(i, 12, { state: "closed" });
  await r.pr(100, "CLOSED", 12);
  const j = await r.attempt({ number: 1, made: 13 });
  await end(db, w, 14);
  await r.pr(101);
  await r.move(j, 15, { pr_number: 101 });
  assert.deepEqual((await linkWorkflows(db, { issues: [issue(1)] })).map((l) => [l.pr, l.live]), [[101, false]]);
  assert.deepEqual(await links(db, 1), [], "live workflows only");
  assert.deepEqual(await links(db, 1, { ended: true }), [[w, 101]]);
});

both("a start takes over the PR of an attempt that has not ended, and neither that of one that has nor one merged or closed before it", async ({ db }) => {
  const r = rows(db);
  for (const [n, o] of [[1, {}], [2, { state: "closed" }], [3, { state: "pr-opened" }]] as const) {
    await r.attempt({ number: n, made: 5, ...o, pr: 100 + n });
    await r.pr(100 + n, n === 3 ? "MERGED" : "OPEN", n === 3 ? 6 : null);
  }
  const ids = await startWorkflows(db, [start(1, 10), start(2, 10), start(3, 10)]);
  const [a, b, c] = [1, 2, 3].map((n) => ids.get(`${REPO}#${n}`)!);
  assert.deepEqual([await r.stored(a!), await r.stored(b!), await r.stored(c!)], [101, null, null]);
  assert.deepEqual(await linkWorkflows(db), []);
  // The end of the attempt whose PR was merged before the start, recorded after it: still none of the workflow's.
  await queryDb(db).run((queryDb(db).k as any).updateTable("main.implementations").set({ state: "merged", updated_at: at(12) }).where("number", "=", 3));
  assert.deepEqual(await linkWorkflows(db), []);
  assert.deepEqual(await links(db, 3), []);
});

both("the link stays when the attempt ends, its PR closes and reopens, and the workflow stops; a restart links its own row, an attempt made for it is its own", async ({ db }) => {
  const r = rows(db);
  const w = await startOne(db, 1, 10);
  const i = await r.attempt({ number: 1, made: 11, pr: 100 });
  await r.pr(100);
  await linkWorkflows(db);
  for (const [m, state] of [[12, "CLOSED"], [13, "OPEN"]] as const) {
    await r.pr(100, state, state === "OPEN" ? null : m);
    await r.move(i, 12, { state: "closed" });
    assert.deepEqual(await linkWorkflows(db), []);
    assert.deepEqual(await links(db, 1), [[w, 100]]);
  }
  // A second attempt has no PR yet, then one: the newest is the workflow's.
  const j = await r.attempt({ number: 1, made: 14 });
  assert.deepEqual(await linkWorkflows(db), []);
  assert.deepEqual(await links(db, 1), [[w, 100]]);
  await r.pr(101);
  await r.move(j, 15, { pr_number: 101 });
  await linkWorkflows(db);
  assert.deepEqual(await links(db, 1), [[w, 101]]);
  assert.deepEqual(await loadLinks(db, { prs: [{ repo: REPO, number: 100 }] }, { ended: true }), [], "the older PR is none of its work, reopened or not");
  await end(db, w, 16);
  const w2 = await startOne(db, 1, 17);
  assert.deepEqual(await links(db, 1, { ended: true }), [[w, 101], [w2, 101]], "both worked on it");
  await r.move(j, 18, { state: "closed" });
  await r.attempt({ number: 1, made: 19, pr: 102 });
  await r.pr(102);
  await linkWorkflows(db);
  assert.deepEqual(await links(db, 1, { ended: true }), [[w, 101], [w2, 102]]);
  assert.deepEqual((await loadLinks(db, { workflowIds: [w2] })).map((l) => l.pr), [102]);
  assert.deepEqual((await loadLinks(db, { prs: [{ repo: REPO, number: 102 }] })).map((l) => l.workflowId), [w2]);
});

both("a carried-over PR stays the workflow's when a new attempt starts after its end", async ({ db }) => {
  const r = rows(db);
  const i = await r.attempt({ number: 1, made: 5, pr: 100 });
  await r.pr(100);
  const w = await startOne(db, 1, 10);
  await r.pr(100, "CLOSED", 11);
  await r.move(i, 12, { state: "closed" });
  await r.attempt({ number: 1, made: 13 });
  assert.deepEqual(await links(db, 1), [[w, 100]]);
  assert.deepEqual(await linkWorkflows(db), []);
});

both("rows written without the link read as the linked ones do, and one run links them; a second PR opened without it is linked then too", async ({ db }) => {
  const r = rows(db);
  const stopped = await r.unlinked(1, 10, "stopped");
  const i = await r.attempt({ number: 1, made: 11, pr: 100 });
  await r.pr(100);
  const w = await r.unlinked(1, 20);
  const read = async () => [await links(db, 1, { ended: true }), await loadLinks(db, { prs: [{ repo: REPO, number: 100 }] }, { ended: true })];
  const plain = await read();
  assert.deepEqual(plain[0], [[stopped, 100], [w, 100]]);
  assert.equal((await linkWorkflows(db)).length, 2);
  assert.deepEqual(await read(), plain);
  assert.deepEqual(await linkWorkflows(db), []);
  await r.move(i, 21, { state: "closed" });
  await r.attempt({ number: 1, made: 22, pr: 101 });
  await r.pr(101);
  assert.deepEqual((await linkWorkflows(db)).map((l) => [l.workflowId, l.pr]), [[w, 101]]);
  assert.deepEqual(await links(db, 1, { ended: true }), [[stopped, 100], [w, 101]]);
});

both("the Task Runner snapshot, the lease and the planner agree on a PR whose attempt ended while its workflow goes on, and on an older PR of the workflow that is reopened", async ({ db }) => {
  const r = rows(db);
  const q = queryDb(db), k = q.k as any;
  const w = await startOne(db, 1, 10);
  const i = await r.attempt({ number: 1, made: 11, pr: 100 });
  await r.pr(100);
  await r.move(i, 12, { state: "closed" });
  // The lease's condition on a call whose item is the PR: the call's id is the PR's number.
  const call = async (pr: number): Promise<boolean> =>
    (await q.all(k.selectFrom("main.items as c").select("c.number").where("c.number", "=", pr).where((eb: any) => startedWorkAllows(db, eb, "ann", "c.number")))).length === 1;
  for (const pr of [100, 101]) await q.run(k.insertInto("main.remote_call_items").values({ call_id: pr, repo: REPO, number: pr, pos: 0 }));
  const says = async (pr: number) => [(await loadStartedWork(db)).prs.some((x) => x.pr === pr), await call(pr), (await loadWorkflowFacts(db, [{ repo: REPO, number: pr }])).ofPr.get(`${REPO}#${pr}`)?.id === w];
  for (const linked of [false, true]) {
    if (linked) await linkWorkflows(db);
    assert.deepEqual(await says(100), [true, true, true]);
  }
  await r.attempt({ number: 1, made: 13, pr: 101 });
  await r.pr(101);
  await q.run(k.updateTable("main.item_workflows").set({ pr_number: null }).where("id", "=", w));
  for (const linked of [false, true]) {
    if (linked) await linkWorkflows(db);
    assert.deepEqual([await says(100), await says(101)], [[false, false, false], [true, true, true]]);
    // Started on its own, the older PR is its own workflow's.
    if (!linked) continue;
    const own = (await startWorkflows(db, [{ ...start(100, 14), kind: "pr", entry: "review" }])).get(`${REPO}#100`)!;
    assert.equal((await loadPrWorkflows(db, [{ repo: REPO, number: 100 }])).get(`${REPO}#100`)!.id, own);
    assert.equal((await loadPrWorkflows(db, [{ repo: REPO, number: 101 }])).get(`${REPO}#101`)!.id, w);
  }
});

// ---- against the rules the link stands for -------------------------------------------------------------------

type Wf = { id: number; number: number; state: string; started: number; born: number };
type Att = { id: number; number: number; state: string; made: number; moved: number; pr: number | null; born: number };
type Pr = { number: number; state: "OPEN" | "CLOSED" | "MERGED"; closed: number | null; mirrored: boolean };
/** One issue's history: what each checkpoint's database holds of it. */
type Snapshot = { wfs: Wf[]; atts: Att[]; prs: Pr[] };

const LIVE = ["running", "waiting", "blocked", "recommending"];
const ENDED_ATTEMPTS = ["merged", "closed", "failed", "cancelled"];
const STEPS = 4, EVENTS = 4;

/** A random history of issue `n` in STEPS checkpoints: up to three workflows and attempts, their PRs mirrored or not. Ids grow with time. */
function history(n: number, x: () => number, id: () => number): Snapshot[] {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(x() * xs.length)]!;
  const wfs: Wf[] = [], atts: Att[] = [], prs: Pr[] = [], out: Snapshot[] = [];
  let m = 0;
  for (let step = 0; step < STEPS; step++) {
    for (let e = 0; e < EVENTS; e++) {
      m++;
      const live = wfs.find((w) => LIVE.includes(w.state)), cur = atts.find((a) => !ENDED_ATTEMPTS.includes(a.state)), pr = prs.length ? pick(prs) : null;
      const can: (() => void)[] = [];
      if (!live && wfs.length < 3) {
        const add = (state: string) => wfs.push({ id: id(), number: n, state, started: m, born: step });
        can.push(() => add(pick(LIVE)), () => add(pick(LIVE)), () => add(pick(["backlog", "closed", "stopped"])));
      }
      if (live && x() < 0.55) can.push(() => { live.state = pick(["done", "stopped", "closed", "backlog"]); });
      if (!cur && atts.length < 3) for (let i = 0; i < (live ? 3 : 1); i++) can.push(() => atts.push({ id: id(), number: n, state: pick(["planning", "implementing"]), made: m, moved: m, pr: null, born: step }));
      if (cur && cur.pr === null) for (let i = 0; i < 3; i++) can.push(() => {
        cur.pr = 100_000 + n * 10 + prs.length;
        Object.assign(cur, { state: "pr-opened", moved: m });
        prs.push({ number: cur.pr, state: "OPEN", closed: null, mirrored: x() < 0.9 });
      });
      if (cur) can.push(() => Object.assign(cur, { state: pick(ENDED_ATTEMPTS), moved: m }));
      if (pr) {
        if (pr.state === "OPEN") can.push(() => Object.assign(pr, { state: pick(["CLOSED", "CLOSED", "MERGED"]), closed: m }));
        else if (pr.state === "CLOSED") can.push(() => Object.assign(pr, { state: "OPEN", closed: null }));
        if (!pr.mirrored) can.push(() => { pr.mirrored = true; });
      }
      if (can.length) pick(can)();
    }
    out.push(structuredClone({ wfs, atts, prs }));
  }
  return out;
}

/** Writes checkpoint `step` of every history into `repo` (ids shifted by `shift`), over the rows the checkpoints before it wrote. */
async function write(db: Db, repo: string, shift: number, step: number, all: Snapshot[][]): Promise<void> {
  const q = queryDb(db), k = q.k as any;
  const now = all.map((h) => h[step]!);
  const put = async (table: string, cols: Record<string, unknown>[], old: Record<string, any>[], keys: string[]) => {
    await kx.updateFrom(db, table, keys, old as never);
    for (const b of kx.batches(cols)) await q.run(k.insertInto(table).values(b));
  };
  await db.write(async () => {
    const wfs = now.flatMap((s) => s.wfs), atts = now.flatMap((s) => s.atts);
    await put("main.item_workflows",
      wfs.filter((w) => w.born === step).map((w) => ({ id: w.id + shift, repo, number: w.number, kind: "issue", entry: "implement", state: w.state, started_by: "ann", started_at: at(w.started), started_via: "cli", updated_at: at(w.started) })),
      wfs.filter((w) => w.born < step).map((w) => ({ id: w.id + shift, state: w.state })), ["id"]);
    await put("main.implementations",
      atts.filter((a) => a.born === step).map((a) => ({ id: a.id + shift, repo, number: a.number, queued_by: "ann", state: a.state, attempt: a.id, text_hash: "h", pr_number: a.pr, created_at: at(a.made), updated_at: at(a.moved) })),
      atts.filter((a) => a.born < step).map((a) => ({ id: a.id + shift, state: a.state, pr_number: a.pr, updated_at: at(a.moved) })), ["id"]);
    const prs = now.flatMap((s) => s.prs).filter((p) => p.mirrored).map((p) => ({ repo, number: p.number, kind: "pr", state: p.state, closed_at: p.closed === null ? null : at(p.closed) }));
    for (const b of kx.batches(prs)) await q.run(k.insertInto("main.items").values(b).onConflict((oc: any) => oc.columns(["repo", "number"]).doUpdateSet(kx.excluded(["state", "closed_at"]))));
  });
  // No autovacuum runs on the throwaway Postgres, and without statistics the trigger of an attempt reads the repo's items once per live workflow.
  if (db.dialect === "postgres") for (const t of ["item_workflows", "implementations", "items"]) await sql.raw(`ANALYZE ${t}`).execute(q.k);
}

type Reading = { live: Map<number, number>; all: Map<number, Map<number, number>> };
/** What the link says of every issue of `repo`: PR to its live workflow, and PR to every workflow on it (id to id), ids unshifted. */
async function reading(db: Db, repo: string, shift: number, numbers: number[]): Promise<Reading> {
  const out: Reading = { live: new Map(), all: new Map() };
  for (const ns of kx.chunks(numbers, KEYS)) for (const l of await loadLinks(db, { issues: ns.map((number) => ({ repo, number })) }, { ended: true })) {
    (out.all.get(l.pr) ?? out.all.set(l.pr, new Map()).get(l.pr)!).set(l.workflowId - shift, l.issue);
    if (l.live) { assert.ok(!out.live.has(l.pr), `two live workflows on #${l.pr}`); out.live.set(l.pr, l.workflowId - shift); }
  }
  return out;
}

const CASES = 400;
/** Keys of one load: SQLite walks the JSON key list once per row it compares. */
const KEYS = 200;
both(`over ${CASES} random histories the link, stored or not, gives what the rules before it gave, but for a PR over before the start, an older PR of the workflow, an attempt that ended in it and a carried-over PR`, async ({ db }) => {
  const x = prng(20260101);
  const numbers = Array.from({ length: CASES }, (_, i) => i + 1);
  let next = 0;
  const all = numbers.map((n) => history(n, x, () => ++next));
  const SHIFT = 1_000_000;
  const refs = (repo: string, ns: number[]) => ns.map((number) => ({ repo, number }));
  // The linked repo's rows get their link at a random half of the checkpoints, as ticks and openings between them would give it; the plain one's never.
  for (let step = 0; step < STEPS; step++) {
    await write(db, "o/linked", 0, step, all);
    await write(db, "o/plain", SHIFT, step, all);
    for (const ns of kx.chunks(numbers.filter(() => step === STEPS - 1 || x() < 0.5), KEYS)) await linkWorkflows(db, { issues: refs("o/linked", ns) });
  }
  for (const ns of kx.chunks(numbers, KEYS)) assert.deepEqual(await linkWorkflows(db, { issues: refs("o/linked", ns) }), [], "a second run");
  for (const name of ["o/linked", "o/plain"]) await addTrackedRepo(db, { name, by: "op" });
  await queryDb(db).run((queryDb(db).k as any).updateTable("main.tracked_repos").set({ pipeline: 1 }));
  const last = all.map((h) => h.at(-1)!);
  const linked = await reading(db, "o/linked", 0, numbers), plain = await reading(db, "o/plain", SHIFT, numbers);
  const keyed = async <T>(ns: number[], load: (part: number[]) => Promise<T[]>): Promise<T[]> => { const out: T[] = []; for (const part of kx.chunks(ns, KEYS)) out.push(...await load(part)); return out; };
  const prNumbers = last.flatMap((s) => s.prs.map((p) => p.number));

  // Every reader of live work agrees with loadLinks, and the ends are the rule's own.
  for (const [repo, shift, got] of [["o/linked", 0, linked], ["o/plain", SHIFT, plain]] as const) {
    const q = queryDb(db), k = q.k as any;
    const pairs = await q.all(k.selectFrom("main.item_workflows as w").innerJoin("main.implementations as a", (j: any) => j.onRef("a.repo", "=", "w.repo").onRef("a.number", "=", "w.number"))
      .where("w.repo", "=", repo).where("a.pr_number", "is not", null).where((eb: any) => worksOnPr(eb, "w", "a.pr_number")).select(["w.id as id", "a.pr_number as pr"])) as { id: number | string; pr: number | string }[];
    assert.deepEqual(pairs.map((p) => `${Number(p.id) - shift}:${p.pr}`).sort(), [...got.all].flatMap(([pr, ws]) => [...ws.keys()].map((w) => `${w}:${pr}`)).sort());
    const pairsOf = (m: Iterable<readonly [number, number]>) => [...m].map(([pr, w]) => `${w}:${pr}`).sort();
    const want = pairsOf(got.live), prsOf = (ns: Iterable<number>) => [...ns].sort(), livePrs = prsOf(got.live.keys());
    const on = await q.all(k.selectFrom("main.items as it").where("it.repo", "=", repo).where((eb: any) => liveWorkflowExpr(eb, "it.repo", "it.number")).select("it.number as n")) as { n: number | string }[];
    const mirrored = new Set(last.flatMap((s) => s.prs.filter((p) => p.mirrored).map((p) => p.number)));
    assert.deepEqual(prsOf(on.map((r) => Number(r.n))), livePrs.filter((n) => mirrored.has(n)));
    assert.deepEqual(pairsOf(await keyed(prNumbers, async (ns) => (await loadLinks(db, { prs: refs(repo, ns) })).map((l) => [l.pr, l.workflowId - shift] as const))), want);
    assert.deepEqual(pairsOf(await keyed(prNumbers, async (ns) => [...await loadPrWorkflows(db, refs(repo, ns), { others: true })].map(([key, w]) => [Number(key.split("#")[1]), w.id - shift] as const))), want);
    const found = await keyed(prNumbers, async (ns) => [await loadWorkflowFacts(db, refs(repo, ns))]);
    assert.deepEqual(pairsOf(found.flatMap((f) => [...f.ofPr].map(([key, w]) => [Number(key.split("#")[1]), w.id - shift] as const))), want);
    assert.deepEqual(prsOf(await keyed(prNumbers, async (ns) => [...(await loadWorkScores(db, refs(repo, ns))).keys()].map((key) => Number(key.split("#")[1])))), livePrs);
    assert.deepEqual(prsOf([...await loadStartedRefs(db, { login: "ann", repos: [repo] })].map((key) => Number(key.split("#")[1])).filter((n) => n > 100_000)), livePrs);
    assert.deepEqual(prsOf((await loadStartedWork(db)).prs.filter((x) => x.repo === repo).map((x) => x.pr)), livePrs);
    const ends = await keyed(prNumbers, async (ns) => [...await loadEndedWorkflows(db, refs(repo, ns))]);
    const rule = await keyed(prNumbers, async (ns) => [...await legacy.loadEndedWorkflows(db, refs(repo, ns))]);
    assert.ok(rule.length > 0);
    assert.deepEqual(ends, rule);
    // In a repo with the Pipeline on, a PR is out of scope exactly when nobody works it and a person ended its issue.
    const left = new Set(ends.flatMap(([key, s]) => (s === "done" ? [] : [Number(key.split("#")[1])])));
    const inScope = await keyed(prNumbers, async (ns) => [...await loadInScope(db, refs(repo, ns))].map((key) => Number(key.split("#")[1])));
    assert.deepEqual(prsOf(inScope), prsOf(prNumbers.filter((n) => got.live.has(n) || !left.has(n))));
    assert.ok(inScope.length > 0 && inScope.length < prNumbers.length);
  }

  const oldLive = new Map(await keyed(prNumbers, async (ns) => [...await legacy.loadPrWorkflows(db, refs("o/plain", ns), { others: true })]));
  const oldStarted = new Set((await legacy.loadStartedPrs(db)).filter((r) => r.repo === "o/plain").map((r) => r.pr));
  const attempts = new Map(await keyed(numbers, async (ns) => [...(await loadImplementFacts(db, refs("o/plain", ns))).byIssue]));
  const stored = new Map((await listWorkflows(db, { repos: ["o/linked"] })).map((w) => [w.id, w.prNumber]));
  const seen = { c1: 0, c2: 0, c3: 0, c7: 0, live: 0 };

  for (const s of last) {
    const n = s.wfs[0]?.number ?? s.atts[0]?.number;
    if (n === undefined) continue;
    const prOf = new Map(s.prs.map((p) => [p.number, p]));
    // The rules, over the rows of this issue.
    const attemptOf = (a: Att, w: Wf) => !ENDED_ATTEMPTS.includes(a.state) || a.made >= w.started || (a.moved >= w.started && !s.atts.some((b) => b.id > a.id));
    const over = (pr: number, w: Wf) => { const p = prOf.get(pr)!; return p.mirrored && p.state !== "OPEN" && p.closed! < w.started; };
    const of = (pr: number) => s.atts.find((a) => a.pr === pr)!;
    const c1 = (pr: number, w: Wf) => attemptOf(of(pr), w) && over(pr, w);
    const c2 = (pr: number, w: Wf) => attemptOf(of(pr), w) && s.atts.some((b) => b.pr !== null && b.id > of(pr).id && attemptOf(b, w));
    // The workflow was linked while the carried-over attempt was the newest; a newer one took its place since.
    const c7 = (pr: number, w: Wf) => !attemptOf(of(pr), w) && of(pr).moved >= w.started;
    const live = s.wfs.find((w) => LIVE.includes(w.state)) ?? null;

    // A live workflow's PR: the pass's own rule, with C7 as the only difference.
    if (live) {
      const a = attempts.get(`o/plain#${n}`) ?? null;
      const cand = legacy.candidatePr(a, { startedAt: at(live.started) });
      const itemOf = (pr: number) => { const p = prOf.get(pr)!; return p.mirrored ? { state: p.state as string, closed_at: p.closed === null ? null : at(p.closed) } : null; };
      const item = cand === null ? null : itemOf(cand);
      const want = legacy.overBefore(item, at(live.started)) ? null : cand;
      assert.equal(workOf(a, { startedAt: at(live.started), prNumber: null }, item).pr, want);
      const of_ = (r: Reading) => s.prs.find((q) => r.live.get(q.number) === live.id)?.number ?? null;
      assert.equal(of_(plain), want, `issue ${n}, not linked`);
      const got = of_(linked), linkedPr = stored.get(live.id) ?? null, li = linkedPr === null ? item : itemOf(linkedPr);
      assert.equal(workOf(a, { startedAt: at(live.started), prNumber: linkedPr }, li).pr, got, `issue ${n}, the pass's rule on the linked row`);
      if (got !== want) { assert.ok(got !== null && c7(got, live), `issue ${n}: linked to ${got}, the rule says ${want}`); seen.c7++; }
      else if (got !== null) seen.live++;
    }

    for (const p of s.prs) {
      const key = `o/plain#${p.number}` as const;
      const was = oldLive.get(key) ? oldLive.get(key)!.id - SHIFT : null;
      const now = plain.live.get(p.number) ?? null;
      if (was !== now) {
        assert.ok(was !== null && now === null && live, `issue ${n} #${p.number}: live ${was} became ${now}`);
        if (c1(p.number, live)) seen.c1++;
        else { assert.ok(c2(p.number, live), `issue ${n} #${p.number}: dropped with no reason`); seen.c2++; }
      }
      // The Task Runner's own rule: a current attempt. The link also covers one that ended while the workflow goes on.
      if (now !== null && !oldStarted.has(p.number)) { assert.ok(ENDED_ATTEMPTS.includes(of(p.number).state)); seen.c3++; }
      if (now === null && oldStarted.has(p.number)) assert.ok(live && c1(p.number, live), `issue ${n} #${p.number}: a working attempt's PR is not its work`);
    }
  }
  for (const [what, count] of Object.entries(seen)) assert.ok(count > 0, `no case of ${what}`);

  // The first run over rows written without the link changes no answer.
  assert.ok((await linkWorkflows(db)).length > 0);
  const first = await reading(db, "o/plain", SHIFT, numbers);
  assert.deepEqual([...first.all].map(([pr, ws]) => [pr, [...ws.keys()].sort()]).sort(), [...plain.all].map(([pr, ws]) => [pr, [...ws.keys()].sort()]).sort());
  assert.deepEqual([...first.live].sort(), [...plain.live].sort());
  assert.deepEqual(await linkWorkflows(db), []);
});

async function flat(n: number) {
  const o = await openApp("sqlite");
  const r = rows(o.db);
  for (let i = 1; i <= n; i++) {
    await r.unlinked(i, 10);
    await r.attempt({ number: i, made: 11, pr: 100 + i });
  }
  return {
    db: o.db, close: () => o.t.close(),
    run: async () => {
      await loadLinks(o.db, { issues: Array.from({ length: n }, (_, i) => issue(i + 1)) });
      assert.equal((await linkWorkflows(o.db)).length, n);
      await loadLinks(o.db, { prs: Array.from({ length: n }, (_, i) => issue(101 + i)) });
    },
  };
}

both("loadLinks and linkWorkflows issue as many statements for 40 workflows as for 4", async () => {
  await expectFlat(flat, 4, 40);
});

both("a PR of an issue a person ended is in scope again once someone starts it on its own, and as before once that ends with nothing to do", async ({ db }) => {
  const q = queryDb(db), k = q.k as any;
  await addTrackedRepo(db, { name: REPO, by: "op" });
  await q.run(k.updateTable("main.tracked_repos").set({ pipeline: 1 }));
  for (const number of [11, 12]) await q.run(k.insertInto("main.items").values({ repo: REPO, number, kind: "pr", state: "OPEN", title: "t", created_at: at(0), updated_at: at(0) }));
  const id = (await startWorkflows(db, [start(1, 1)])).get(`${REPO}#1`)!;
  await q.run(k.insertInto("main.implementations").values({ repo: REPO, number: 1, queued_by: "ann", state: "pr-opened", attempt: 1, text_hash: "h", pr_number: 11, created_at: at(2), updated_at: at(2) }));
  const scope = async () => [...await loadInScope(db, [11, 12].map((number) => ({ repo: REPO, number })))].sort();
  const both = [`${REPO}#11`, `${REPO}#12`];
  assert.deepEqual(await scope(), both);
  await q.run(k.updateTable("main.item_workflows").set({ state: "done" }).where("id", "=", id));
  assert.deepEqual(await scope(), both, "an answer that runs nothing");
  for (const state of ["stopped", "backlog", "closed"]) {
    await q.run(k.updateTable("main.item_workflows").set({ state }).where("id", "=", id));
    assert.deepEqual(await scope(), [both[1]], state);
  }
  const own = (await startWorkflows(db, [{ ...start(11, 5), kind: "pr", entry: "review" }])).get(both[0]!)!;
  assert.deepEqual(await scope(), both);
  await q.run(k.updateTable("main.item_workflows").set({ state: "done" }).where("id", "=", own));
  assert.deepEqual(await scope(), both, "the newest end is not a person's");
});

both("the post-merge review step's calls on a PR whose workflow ended done through its merge, a reference check included, are that workflow's work, in the snapshot and the lease alike, and no other step's are", async ({ db }) => {
  const r = rows(db);
  const q = queryDb(db), k = q.k as any;
  const review = (number: number) => ({ ...start(number, 1), kind: "pr" as const, entry: "review" as const, approvedBy: "bob", approvedVia: "cli" as const });
  const ids = await startWorkflows(db, [review(200), review(201), { ...start(202, 1), kind: "pr", entry: "review" }]);
  await r.pr(200, "MERGED", 5);
  await r.pr(201, "OPEN");
  await r.pr(202, "MERGED", 5);
  // 200 merged through its workflow; 201's workflow ended with an answer and its PR stays open; 202's was held before someone else merged it.
  await end(db, ids.get(`${REPO}#200`)!, 6, "done");
  await end(db, ids.get(`${REPO}#201`)!, 6, "done");
  await end(db, ids.get(`${REPO}#202`)!, 4, "stopped");
  // The lease's condition on a call whose item is the PR: the call's id is the PR's number, its step the item's title.
  for (const pr of [200, 201, 202]) await q.run(k.insertInto("main.remote_call_items").values({ call_id: pr, repo: REPO, number: pr, pos: 0 }));
  const says = async (pr: number, login: string, step: string, now: number): Promise<[boolean, boolean]> => {
    await q.run(k.updateTable("main.items").set({ title: step }).where("number", "=", pr));
    const lease = (await q.all(k.selectFrom("main.items as c").select("c.number").where("c.number", "=", pr)
      .where((eb: any) => startedWorkAllows(db, eb, login, "c.number", { stepRef: "c.title", now })))).length === 1;
    const snapshot = await loadRunnerSnapshot(db, now, { started: loadStartedWork, denials: async () => new Map() });
    const owners = startedOf({ now, snapshot, accepted: { top: [], mid: [], small: [] } }).owners([{ repo: REPO, number: pr }], step);
    return [owners.has(login), lease];
  };
  const soon = Date.parse(at(60)), later = Date.parse(at(6)) + 4 * 24 * 3600_000;
  assert.deepEqual(await says(200, "bob", "postmerge", soon), [true, true], "the approver");
  assert.deepEqual(await says(200, "ann", "postmerge", soon), [true, true], "the starter");
  assert.deepEqual(await says(200, "cid", "postmerge", soon), [false, false], "nobody else");
  assert.deepEqual(await says(200, "bob", "opus-review", soon), [false, false], "only the post-merge review step");
  assert.deepEqual(await says(201, "bob", "postmerge", soon), [false, false], "a workflow that ended without a merge");
  assert.deepEqual(await says(202, "ann", "postmerge", soon), [false, false], "a workflow that did not end through the merge");
  assert.deepEqual(await says(200, "bob", "postmerge", later), [false, false], "days after the workflow ended");
});

both("a Task Runner taken onto a live workflow's work counts in the snapshot and the lease alike while no runner of its starter is ready with room, and not after a release, the workflow's end or a new start", async ({ db }) => {
  const r = rows(db);
  const q = queryDb(db), k = q.k as any;
  const review = (number: number, m: number) => ({ ...start(number, m), kind: "pr" as const, entry: "review" as const });
  await r.pr(300);
  const first = (await startWorkflows(db, [review(300, 1)])).get(`${REPO}#300`)!;
  // The lease's condition on a call whose item is the PR: the call's id is the PR's number.
  await q.run(k.insertInto("main.remote_call_items").values({ call_id: 300, repo: REPO, number: 300, pos: 0 }));
  // The snapshot and the lease of a call of `tier`: the lease reads the credentials that serve the tier from the snapshot, as a claim does.
  const says = async (login: string, tier: Tier = "top"): Promise<[boolean, boolean]> => {
    const now = Date.now();
    const snapshot = await loadRunnerSnapshot(db, now, { started: loadStartedWork, denials: async () => new Map() });
    const view = { now, snapshot, accepted: { top: ["opus"], mid: ["sonnet"], small: ["haiku"] } };
    const lease = (await q.all(k.selectFrom("main.items as c").select("c.number").where("c.number", "=", 300)
      .where((eb: any) => startedWorkAllows(db, eb, login, "c.number", { now, tierTokens: tierTokens(view, tier) })))).length === 1;
    return [startedOf(view).owners([{ repo: REPO, number: 300 }], undefined, tier).has(login), lease];
  };
  const grant = (workflowId: number) => takeItemRunner(db, { workflowId, repo: REPO, number: 300, login: "Cid", at: at(2) });
  assert.equal(await grant(first), true);
  assert.equal(await grant(first), false, "one live grant per person");
  assert.deepEqual(await says("cid"), [true, true], "the starter has no Task Runner");
  assert.deepEqual(await says("dot"), [false, false], "nobody else");

  // The starter's runner that could run the call now comes first; inactive, without the call's tier, held for its usage, or full, it does not.
  await q.run(k.insertInto("main.access").values({ login: "ann", role: "maintainer" }));
  const token = (await createToken(db, "ann", "runner", { kind: "runner" })).row.id;
  const status = (readiness: string, models: Record<string, string> = { top: "opus" }) =>
    storeStatus(db, token, "ann", parseStatus({ slots: 3, busy: 0, readiness, harness: "claude", models, reserve: { fiveHour: 0, weekly: 0 } }));
  await status("ready");
  assert.deepEqual(await says("cid"), [true, true], "the starter's runner neither runs a lease nor claimed lately");
  await q.run(k.updateTable("main.remote_helpers").set({ idle_claim_at: Date.now() }).where("token_id", "=", token));
  assert.deepEqual(await says("cid"), [false, false], "the starter's runner is ready with room");
  await status("ready", { small: "haiku" });
  assert.deepEqual(await says("cid"), [true, true], "the starter's runner does not serve the call's tier");
  assert.deepEqual(await says("cid", "small"), [false, false], "it serves a call of its own tier");
  await status("ready");
  await status("quota-held");
  assert.deepEqual(await says("cid"), [true, true], "the starter's runner is held by its usage limit");
  await status("ready");
  for (const id of [901, 902]) await q.run(k.insertInto("main.remote_calls").values({ id, step: "opus-review", stage: 0, prompt_id: "review.opus", prompt_version: "1", tier: "top", effort: "medium", asked_model: "opus", bundle: "{}", state: "leased", since: 0, seen_at: 0, max_attempts: 2, timeout_ms: 60_000, token_id: token, user_login: "ann", leased_at: Date.now(), heartbeat_at: Date.now() }));
  assert.deepEqual(await says("cid"), [true, true], "the starter's runner has no free slot");

  assert.equal(await releaseItemRunner(db, { workflowId: first, login: "cid", at: at(3) }), true);
  assert.deepEqual(await says("cid"), [false, false], "released");
  await grant(first);
  await end(db, first, 4);
  assert.deepEqual(await says("cid"), [false, false], "the workflow ended");
  await startWorkflows(db, [review(300, 5)]);
  assert.deepEqual(await says("cid"), [false, false], "a new start does not inherit the grant");
});
