// changes module: set loaders stay flat in statements, the patch-row writers compare and set, the main-fix upsert keeps its creation
// time, and the pure helpers read rows with equal times by id (SQLite; Postgres when AUTOCRAFT_TEST_PG_URL is set).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db, Dialect } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import {
  attemptsIn, cifixAt, clearSessions, countMainFixes, failuresSince, finishInfraRerun, finishPatch, fixupAtHead, loadFixupVerdicts, loadLatestFixPushes, loadLatestFixupAt, loadLintingRows,
  loadMainFixDue, loadMainFixes, loadMainFixStates, loadOpenFixPr, loadOperatorFixResults, loadPatchFacts, loadPatchSignature, loadPatchTimeline, loadPushEdges, loadSessionRows, loadStoredPatches,
  lintOf, madeBy, outcomeRows, pushChainOf, recordPatchChecks, recordPushing, saveMainFixes, setOwnDiff, startInfraRerun, storePatch, supersedePatches,
} from "../../src/data/changes/index.ts";
import type { MainFixRow } from "../../src/data/changes/index.ts";
import { expectFlat } from "../helpers/query-count.ts";
import { TEST_PG_URL, testDatabase } from "../test-db.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";

async function withDb(dialect: Dialect, fn: (db: Db) => Promise<unknown>): Promise<unknown> {
  const t = await testDatabase("", dialect);
  try { return await fn(await t.open({ app: true })); } finally { await t.close(); }
}

/** Runs on SQLite, and on Postgres when a server is configured; both must give the same result. */
function both(name: string, fn: (db: Db) => Promise<unknown>): void {
  test(name, async () => {
    const lite = await withDb("sqlite", fn);
    if (TEST_PG_URL) assert.deepEqual(await withDb("postgres", fn), lite);
  });
}

const refs = (n: number) => Array.from({ length: n }, (_, i) => ({ repo: "app", number: i + 1 }));
const k = (db: Db) => queryDb(db).k as any;

/** Each PR has a pushed fix-up, a merged conflict merge, a CI fix and a stored linting fix-up, a model check and a patch check. */
async function seed(db: Db, n: number): Promise<void> {
  for (const r of refs(n)) {
    const h = `h${r.number}`;
    await queryDb(db).run(k(db).insertInto("fixups").values([
      { ...r, from_head: h, to_head: `${h}f`, state: "pushed", files: '["a.rs"]', attempt: 1, created_at: T0, patch: "+x\n-y\n", source: null },
      { ...r, from_head: `${h}f`, state: "linting", attempt: 1, created_at: T1, patch: "+z\n", lint_task: 5, lint_round: 1, lint_state: "pending", source: "premerge" },
    ]));
    await queryDb(db).run(k(db).insertInto("conflict_merges").values({ ...r, from_head: `${h}f`, to_head: `${h}m`, state: "merged", files: "[]", attempt: 1, created_at: T1, own_diff: "same" }));
    await queryDb(db).run(k(db).insertInto("ci_fixes").values({ ...r, head: `${h}m`, kind: "code", state: "linting", files: "[]", attempt: 1, created_at: T1, patch: "+c\n", lint_task: 6 }));
    await queryDb(db).run(k(db).insertInto("model_checks").values({ step: "fixup", ...r, head: h, command: "fmt", started_at: T0 }));
    await queryDb(db).run(k(db).insertInto("patch_checks").values({ kind: "fixup", ...r, subject: h, patch_hash: "x", round: 1, verdict: "approve", reasons: "ok", problems: "[]", model: "m", created_at: T0 }));
  }
}

for (const dialect of ["sqlite" as const, ...(TEST_PG_URL ? ["postgres" as const] : [])]) {
  test(`changes loaders: statements do not grow with the PR count (${dialect})`, async () => {
    const loaders = {
      facts: (db: Db, keys: ReturnType<typeof refs>) => loadPatchFacts(db, keys),
      edges: (db: Db, keys: ReturnType<typeof refs>) => loadPushEdges(db, keys),
      stored: (db: Db, keys: ReturnType<typeof refs>) => loadStoredPatches(db, keys),
      linting: (db: Db, keys: ReturnType<typeof refs>) => loadLintingRows(db, keys),
      timeline: (db: Db, keys: ReturnType<typeof refs>) => loadPatchTimeline(db, keys, { internals: false }),
      signature: (db: Db, keys: ReturnType<typeof refs>) => loadPatchSignature(db, keys),
      latest: (db: Db, keys: ReturnType<typeof refs>) => loadLatestFixPushes(db, keys),
      verdicts: (db: Db, keys: ReturnType<typeof refs>) => loadFixupVerdicts(db, keys.map((r) => ({ ref: `${r.repo}#${r.number}`, subject: `h${r.number}` }))),
      latestAt: (db: Db, keys: ReturnType<typeof refs>) => loadLatestFixupAt(db, keys.map((r) => ({ ref: `${r.repo}#${r.number}`, head: `h${r.number}` }))),
    };
    for (const [name, load] of Object.entries(loaders)) {
      await expectFlat(async (n) => {
        const t = await testDatabase("", dialect);
        const db = await t.open({ app: true });
        await seed(db, n);
        return { db, close: () => t.close(), run: () => load(db, refs(n)) };
      }, 2, 12).catch((e) => { throw new Error(`${name}: ${(e as Error).message}`); });
    }
  });
}

both("patch facts: rows by id without blobs, push edges across the three kinds newest first, and the chain through them", async (db) => {
  await seed(db, 2);
  const f = (await loadPatchFacts(db, refs(2))).get("app#1")!;
  assert.deepEqual(f.fixups.map((r) => r.state), ["pushed", "linting"]);
  assert.ok(!("patch" in f.fixups[0]!));
  assert.deepEqual(f.pushes.map((e) => e.kind).sort(), ["conflict", "fixup"]);
  const edges = (await loadPushEdges(db, refs(2))).get("app#1")!;
  assert.deepEqual(pushChainOf(edges, "h1m"), ["h1m", "h1f", "h1"]);
  assert.equal(madeBy(edges, "h1m")?.kind, "conflict");
  assert.equal(madeBy(edges, "h1f")?.kind, "fixup");
  assert.equal(madeBy(edges, "other"), null);
  assert.deepEqual(lintOf(f, "h1f", { cifixHead: "h1m", tasks: new Map() }).map((l) => `${l.step}:${l.source}`), ["fixup:premerge", "cifix:review"]);
  const latest = (await loadLatestFixPushes(db, refs(2))).get("app#1")!;
  assert.equal(latest.lines, 2);
  assert.deepEqual(latest.files, ["a.rs"]);
});

both("finishPatch updates the open row of its key, inserts when none is open, and keeps a CI fix's unsent row apart from the open one", async (db) => {
  const key = { repo: "app", number: 1 };
  await recordPushing(db, { kind: "fixup", ...key, head: "a", commit: "b", files: ["x"], attempt: 1, at: T0 });
  await finishPatch(db, { kind: "fixup", ...key, head: "a", state: "pushed", reason: null, files: ["x"], toHead: "b", note: { ...key, stage: "take", at: T1, actor: "t", note: "n" }, jobNote: null });
  let facts = (await loadPatchFacts(db, [key])).get("app#1")!;
  assert.equal(facts.fixups.length, 1, "the pushing row was finished, not duplicated");
  assert.equal(facts.fixups[0]!.state, "pushed");
  assert.equal(Number((await queryDb(db).get(k(db).selectFrom("main.stages").select((eb: any) => eb.fn.countAll().as("n"))) as any).n), 1);
  // No open row: a new one.
  await finishPatch(db, { kind: "fixup", ...key, head: "c", state: "cannot-push", reason: "r", files: [], note: null, jobNote: null, at: T1 });
  assert.equal((await loadPatchFacts(db, [key])).get("app#1")!.fixups.length, 2);

  // A CI fix: a formatting row is replaced in place by its result; comment-unsent inserts and leaves the stored patch.
  await storePatch(db, { kind: "cifix", ...key, head: "h", patch: "+p", files: ["a.rs"], lintTask: 3, lintRound: 1, lintState: "pending", session: null, attempt: 1, at: T0 });
  await finishPatch(db, { kind: "cifix", ...key, head: "h", state: "comment-unsent", reason: "no token", files: [], note: null, jobNote: null, at: T1 });
  facts = (await loadPatchFacts(db, [key])).get("app#1")!;
  assert.deepEqual(facts.cifixes.map((r) => r.state), ["linting", "comment-unsent"]);
  assert.equal((await loadStoredPatches(db, [key], ["cifix"]))[0]!.patch, "+p");
  await finishPatch(db, { kind: "cifix", ...key, head: "h", state: "pushed", reason: null, files: ["a.rs"], toHead: "h2", note: null, jobNote: null, at: T1 });
  facts = (await loadPatchFacts(db, [key])).get("app#1")!;
  assert.deepEqual(facts.cifixes.map((r) => r.state), ["pushed", "comment-unsent"]);
});

both("a stored patch moves to pushing by its id, and supersede only touches rows still linting", async (db) => {
  const key = { repo: "app", number: 1 };
  await storePatch(db, { kind: "fixup", ...key, head: "a", patch: "+p", files: ["a.rs"], lintTask: 1, lintRound: 1, lintState: "pending", session: "s", attempt: 1, at: T0 });
  await storePatch(db, { kind: "conflict", ...key, head: "a", patch: "[]", files: [], lintTask: 2, lintRound: 1, lintState: "pending", session: null, baseSha: "base", attempt: 1, at: T0 });
  const [stored] = await loadStoredPatches(db, [key], ["fixup"]);
  await storePatch(db, { kind: "fixup", ...key, storedId: stored!.id, head: "a", patch: "+q", files: ["a.rs"], lintTask: 3, lintRound: 2, lintState: "requeued", session: "s", attempt: 1 });
  const again = (await loadStoredPatches(db, [key], ["fixup"]))[0]!;
  assert.equal(again.id, stored!.id);
  assert.equal(again.kind === "fixup" && again.lintRound, 2);
  const linting = await loadLintingRows(db, [key]);
  assert.equal(linting.length, 2);
  await recordPushing(db, { kind: "fixup", ...key, head: "a", commit: "b", files: ["a.rs"], attempt: 1, storedId: stored!.id });
  assert.equal(await supersedePatches(db, linting.map((r) => ({ kind: r.kind, id: r.id })), "gone"), 1, "the fix-up row is pushing now, only the conflict row was still linting");
  assert.deepEqual((await loadLintingRows(db, [key])).length, 0);
});

both("setOwnDiff and the infra rerun pair write many rows in one statement each", async (db) => {
  const k1 = { repo: "app", number: 1 }, k2 = { repo: "app", number: 2 };
  for (const key of [k1, k2]) await finishPatch(db, { kind: "conflict", ...key, head: "a", state: "merged", reason: null, files: [], toHead: "m", note: null, jobNote: null, at: T0 });
  await setOwnDiff(db, [{ ...k1, toHead: "m", ownDiff: "same", ownDelta: null }, { ...k2, toHead: "m", ownDiff: "changed", ownDelta: "delta" }]);
  const edges = await loadPushEdges(db, [k1, k2]);
  assert.equal(edges.get("app#1")![0]!.ownDiff, "same");
  assert.equal(edges.get("app#2")![0]!.ownDiff, "changed");
  await startInfraRerun(db, [{ ...k1, head: "h", runs: [1, 2], at: T0 }, { ...k2, head: "h", runs: [3], at: T0 }]);
  await finishInfraRerun(db, [{ ...k1, head: "h", runs: [1, 2], at: T0, state: "rerun", reason: null }, { ...k2, head: "h", runs: [3], at: T0, state: "rerun", reason: "refused" }]);
  const facts = (await loadPatchFacts(db, [k1, k2]));
  assert.deepEqual(facts.get("app#1")!.cifixes.map((r) => [r.state, r.runs]), [["rerun", [1, 2]]]);
  assert.equal(facts.get("app#2")!.cifixes[0]!.reason, "refused");
});

const mainRow = (o: Partial<MainFixRow>): MainFixRow => ({
  repo: "app", headSha: "red", check: "build", verdict: "code", state: "needs-fix", reason: null, runId: null, runUrl: null, excerpt: null, issueNumber: null, prNumber: null, prUrl: null, patch: null,
  files: null, lintTask: null, lintRound: null, lintState: null, session: null, createdAt: T0, updatedAt: T0, ...o,
});

both("main fix rows upsert in one call, keep their creation time, and answer the due question for every head at once", async (db) => {
  await saveMainFixes(db, [mainRow({}), mainRow({ check: "lint", state: "linting", lintTask: 4 }), mainRow({ headSha: "old", state: "needs-fix" })], T0);
  await saveMainFixes(db, [mainRow({ state: "pr-opened", prNumber: 7, createdAt: T1 })], T1);
  const [row] = await loadMainFixes(db, { heads: [{ repo: "app", headSha: "red" }] });
  assert.equal(row!.check, "build");
  assert.equal(row!.state, "pr-opened");
  assert.equal(row!.createdAt, T0, "created_at is not rewritten");
  assert.equal(row!.updatedAt, T1);
  assert.equal(await loadOpenFixPr(db, "app", T0), 7, "a PR the sync has not read yet was just opened");
  await queryDb(db).run(queryDb(db).k.insertInto("items").values({ repo: "app", number: 7, kind: "pr", state: "CLOSED", created_at: T0, updated_at: T0 } as never));
  assert.equal(await loadOpenFixPr(db, "app", T0), null);
  const due = (await loadMainFixDue(db, [{ repo: "app", headSha: "red", running: false }, { repo: "app", headSha: "new", running: true }]));
  assert.deepEqual(due.get("app@red")!.rows.map((r) => r.check), ["build", "lint"]);
  assert.equal(due.get("app@red")!.staleNeedsFix, true, "an older head still holds a needs-fix row");
  assert.equal(due.get("app@new")!.staleNeedsFix, false, "a running head waits");
  assert.equal(due.get("app@new")!.opening, false);
  await saveMainFixes(db, [mainRow({ headSha: "old", check: "infra", state: "issue-opening" })], T0);
  assert.equal((await loadMainFixDue(db, [{ repo: "app", headSha: "new", running: true }])).get("app@new")!.opening, true, "an interrupted issue is settled whatever the head is");
  assert.equal(due.get("app@new")!.lintingHeads[0]!.headSha, "red");
  assert.equal(await countMainFixes(db, { state: "needs-fix" }), 1);
  assert.deepEqual((await loadMainFixStates(db, [{ repo: "app", headSha: "red" }])).get("app@red"), { states: ["pr-opened", "linting"], prNumber: 7 });
  assert.equal((await loadMainFixes(db, { repo: "app", states: ["linting"], verdict: "code" })).length, 1);
});

both("session rows list the four tables by id and clearing them touches only the named rows", async (db) => {
  const key = { repo: "app", number: 1 };
  await storePatch(db, { kind: "fixup", ...key, head: "a", patch: "+p", files: [], lintTask: 1, lintRound: 1, lintState: "pending", session: "one", attempt: 1, at: T0 });
  await storePatch(db, { kind: "fixup", ...key, head: "b", patch: "+p", files: [], lintTask: 1, lintRound: 1, lintState: "pending", session: "two", attempt: 1, at: T0 });
  await saveMainFixes(db, [mainRow({ session: "three" })], T0);
  const rows = await loadSessionRows(db);
  assert.deepEqual(rows.map((r) => [r.kind, r.session]), [["fixup", "one"], ["fixup", "two"], ["main", "three"]]);
  assert.equal(await clearSessions(db, [{ kind: "fixup", id: rows[0]!.id }, { kind: "main", id: rows[2]!.id }]), 2);
  assert.deepEqual((await loadSessionRows(db)).map((r) => r.session), ["two"]);
});

both("patch checks batch into one insert and the newest verdict per subject wins", async (db) => {
  const base = { kind: "fixup" as const, repo: "app", number: 1, subject: "h", patch: "+x", round: 1, model: "m", at: T0 };
  await recordPatchChecks(db, [{ ...base, check: { verdict: "reject", reasons: "no", problems: ["p"] } }, { ...base, round: 2, check: { verdict: "approve", reasons: "yes", problems: [] } }]);
  assert.equal((await loadFixupVerdicts(db, [{ ref: "app#1", subject: "h" }])).get("app#1@h"), "approve");
});

test("helpers that sort rows read equal times by id, and failures and outcomes read the loaded rows", () => {
  const row = (id: number, state: string, o: object = {}) => ({ id, repo: "r", number: 1, createdAt: T0, fromHead: "h", toHead: null, state, reason: null, source: null, attempt: 1, lintTask: null, lintState: null, operatorFix: null, ...o });
  const facts = { fixups: [row(2, "comment-unsent"), row(1, "pushed")], cifixes: [], conflicts: [], pushes: [] };
  assert.deepEqual(fixupAtHead(facts.fixups, "h", Date.parse(T0)).recorded, ["pushed"], "the unsent row is not a recorded state");
  assert.equal(outcomeRows(facts, "fixup")[0]!.state, "comment-unsent", "newest first: the larger id at an equal time");
  assert.equal(outcomeRows(facts, "fixup")[0]!.unsent, 1);
  assert.equal(attemptsIn([row(1, "refused", { reason: "Truncated hunk at 3" }), row(2, "failed")]), 1, "a hunk-header refusal is not a try");
  assert.deepEqual(failuresSince({ ...facts, fixups: [row(1, "failed", { createdAt: T1 }), row(2, "failed")] }, T0), [{ step: "fix-up", count: 1 }, { step: "CI fix", count: 0 }]);
  const cf = (id: number, state: string, o: object = {}) => ({ id, repo: "r", number: 1, createdAt: T0, head: "h", toHead: null, kind: "format" as const, state, reason: null, files: [], attempt: 1, taskId: null, lintTask: null, runs: null, ...o });
  const at = cifixAt([cf(2, "pushed"), cf(1, "formatting", { taskId: 9 })], "h", Date.parse(T0), new Map([[9, { state: "running" as const, step: "s", endedAt: null }]]));
  assert.deepEqual(at.states, ["formatting", "pushed"]);
  assert.equal(at.formatterEnded, false);
});

test("operator fix results come back one per request, the newest row", async () => {
  const lite = await withDb("sqlite", async (db) => {
    const key = { repo: "app", number: 1 };
    await queryDb(db).run(k(db).insertInto("fixups").values([
      { ...key, from_head: "a", state: "failed", files: "[]", attempt: 1, created_at: T0, source: "operator", operator_fix: 7 },
      { ...key, from_head: "a", state: "pushed", files: "[]", attempt: 2, created_at: T1, source: "operator", operator_fix: 7, to_head: "b" },
      { ...key, from_head: "a", state: "failed", files: "[]", attempt: 1, created_at: T1, source: "operator", operator_fix: 8 },
    ]));
    return [...(await loadOperatorFixResults(db, [7, 8, 9])).entries()];
  });
  assert.deepEqual(lite, [[7, { state: "pushed", fromHead: "a", toHead: "b", reason: null }], [8, { state: "failed", fromHead: "a", toHead: null, reason: null }]]);
});
