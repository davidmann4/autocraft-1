// The control module's set loaders and batch writers cost the same number of statements for 2 keys as for 12, and the
// compare-and-set writers keep their once-only rules. Each case runs on SQLite, and on Postgres when AUTOCRAFT_TEST_PG_URL is set.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db, Dialect } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import {
  addAudit, addOwnCommits, addPushOutcomes, addTrackedRepo, countPushOutcomes, evaluatePushBreakers, listAudit, listAuditPage, listPushOutcomes, loadActBlocked,
  loadAssignments, loadAuditActions, loadAuditMax, loadBreakerSince, loadOwnCommits, loadPaceWaits, loadPushFacts, loadPushOutcomeEdges, loadRepoGuards,
  loadStageLimits, loadStepApprovals, loadTrips, loadWriteLog, pushesUnsettled, resetLimitCounts, resolvePushes, resumeTrips, setStageLimit, setStepApproval,
  tripMergeBreakers, tripStage,
} from "../../src/data/control/index.ts";
import { expectFlat } from "../helpers/query-count.ts";
import { TEST_PG_URL, testDatabase } from "./../test-db.ts";

async function open(dialect: Dialect): Promise<{ db: Db; close(): Promise<void> }> {
  const t = await testDatabase("", dialect);
  const db = await t.open({ app: true });
  return { db, close: () => t.close() };
}

/** Runs `fn` on SQLite, and on Postgres when a server is configured. */
function both(name: string, fn: (db: Db) => Promise<void>): void {
  test(name, async () => {
    for (const d of TEST_PG_URL ? (["sqlite", "postgres"] as const) : (["sqlite"] as const)) {
      const { db, close } = await open(d);
      try { await fn(db); } finally { await close(); }
    }
  });
}

/** `expectFlat` over fresh databases: `seed(db, n)` fills one with n keys, `run(db, n)` is the metered work. */
async function flat(dialect: Dialect, seed: (db: Db, n: number) => Promise<void>, run: (db: Db, n: number) => Promise<unknown>): Promise<void> {
  await expectFlat(async (n) => {
    const { db, close } = await open(dialect);
    await seed(db, n);
    return { db, run: () => run(db, n), close };
  }, 2, 12);
}

function bothFlat(name: string, seed: (db: Db, n: number) => Promise<void>, run: (db: Db, n: number) => Promise<unknown>): void {
  test(name, async () => {
    for (const d of TEST_PG_URL ? (["sqlite", "postgres"] as const) : (["sqlite"] as const)) await flat(d, seed, run);
  });
}

const repos = (n: number): string[] => Array.from({ length: n }, (_, i) => `repo${i}`);
const refs = (n: number): { repo: string; number: number }[] => repos(n).map((repo, i) => ({ repo, number: i + 1 }));

const seedRepos = async (db: Db, n: number): Promise<void> => {
  for (const r of repos(n)) await addTrackedRepo(db, { name: r, by: "op" });
  await setStepApproval(db, repos(n).flatMap((repo) => [{ repo, step: "merge" as const, on: true }, { repo, step: "push" as const, on: true }]), "op");
};

bothFlat("approval loaders and guards read in a fixed number of statements", seedRepos, async (db, n) => {
  await db.together(() => Promise.all([loadStepApprovals(db, repos(n)), loadStepApprovals(db, "all"), loadStepApprovals(db, refs(n)), loadRepoGuards(db, repos(n)), loadActBlocked(db, repos(n))]));
});

bothFlat("approval writer changes many rows in a fixed number of statements", async (db, n) => { for (const r of repos(n)) await addTrackedRepo(db, { name: r, by: "op" }); },
  (db, n) => setStepApproval(db, repos(n).map((repo) => ({ repo, step: "merge" as const, on: true })), "op"));

const outcomeRows = (n: number) => refs(n).map((r) => ({ action: "fixup-push", repo: r.repo, number: r.number, from: `a${r.number}`, to: `b${r.number}` }));

bothFlat("push outcome loaders and the recorder use a fixed number of statements", async (db, n) => { await addPushOutcomes(db, outcomeRows(n)); },
  async (db, n) => {
    await db.together(() => Promise.all([loadPushFacts(db, refs(n)), loadPushOutcomeEdges(db, refs(n)), listPushOutcomes(db, { refs: refs(n).map((r) => `${r.repo}#${r.number}`) }),
      countPushOutcomes(db, refs(n).map((r) => `${r.repo}#${r.number}`)), pushesUnsettled(db, repos(n))]));
    await addPushOutcomes(db, outcomeRows(n).map((r) => ({ ...r, to: `c${r.number}` })));
  });

bothFlat("settling pushes and evaluating breakers use a fixed number of statements", async (db, n) => { await addPushOutcomes(db, outcomeRows(n)); },
  async (db, n) => {
    await resolvePushes(db, refs(n).map((r) => ({ repo: r.repo, number: r.number, head_oid: `b${r.number}`, checks: JSON.stringify([{ name: "ci", state: "success" }]) })));
    await evaluatePushBreakers(db, repos(n).map((repo) => ({ stage: "fixup", repo })));
  });

bothFlat("breakers load and trip in a fixed number of statements", async (db, n) => { await tripStage(db, [{ key: "fixup", reason: "r", evidence: [], at: "2026-01-01T00:00:00Z" }]); await resumeTrips(db, ["fixup"], "op"); },
  async (db, n) => {
    await db.together(() => Promise.all([loadTrips(db), loadTrips(db, { keys: repos(n).map((r) => `merge:${r}`) }), loadBreakerSince(db, repos(n).map((r) => `merge:${r}`))]));
    await tripMergeBreakers(db, refs(n).map((r) => ({ ...r, mergedAt: "2026-02-01T00:00:00Z", reason: "red", evidence: [] })));
    await resumeTrips(db, repos(n).map((r) => `merge:${r}`), "op");
  });

bothFlat("limits and own commits use a fixed number of statements", async () => {}, async (db, n) => {
  await resetLimitCounts(db, repos(n), "2026-01-01T00:00:00Z", {}, "op");
  await setStageLimit(db, "act", 3, "op");
  await db.together(() => Promise.all([loadStageLimits(db, { act: 5 }), loadOwnCommits(db, refs(n).map((r) => ({ repo: r.repo, sha: `s${r.number}` })))]));
  await addOwnCommits(db, refs(n).map((r) => ({ repo: r.repo, sha: `s${r.number}`, action: "fixup-push" })));
});

const seedAudit = async (db: Db, n: number): Promise<void> => {
  await addAudit(db, refs(n).flatMap((r) => [
    { login: "bot", action: "assign", target: `${r.repo}#${r.number}`, details: { assignee: "bot", run: "r1" } },
    { login: "bot", action: "act-comment", target: `${r.repo}#${r.number}`, details: { state: "done", url: "https://x/y#issuecomment-1" } },
    { login: "bot", action: "deadline-ack", target: `step:s${r.number}` },
  ]));
};

bothFlat("audit readers use a fixed number of statements", seedAudit, async (db, n) => {
  const targets = refs(n).map((r) => `${r.repo}#${r.number}`);
  await db.together(() => Promise.all([
    loadAuditActions(db, targets, ["assign", "act-comment"]), loadAuditMax(db, "deadline-ack", refs(n).map((r) => `step:s${r.number}`)), loadAssignments(db, { refs: targets }),
    loadWriteLog(db, targets), listAudit(db, { targets }), listAuditPage(db, { limit: 5, offset: 0 }),
    loadPaceWaits(db, repos(n).map((o) => ({ action: "labels-apply", identity: "app", owner: o })), Date.now()),
  ]));
});

bothFlat("audit rows of any number are one statement", async () => {}, (db, n) => addAudit(db, refs(n).map((r) => ({ login: "x", action: "a", target: `${r.repo}#${r.number}`, details: { n: r.number } }))));

both("a trip is set once: a second trip of an active breaker changes nothing and audits nothing", async (db) => {
  const at = "2026-01-01T00:00:00Z";
  assert.deepEqual(await tripStage(db, [{ key: "fixup:app", reason: "first", evidence: ["a"], at }, { key: "fixup:app", reason: "dup", evidence: [], at }]), ["fixup:app"]);
  assert.deepEqual(await tripStage(db, [{ key: "fixup:app", reason: "second", evidence: ["b"], at }]), []);
  assert.equal((await loadTrips(db)).get("fixup:app")?.reason, "first");
  assert.equal((await listAudit(db, { actions: ["stage-trip"] })).length, 1);
  await resumeTrips(db, ["fixup:app"], "op");
  assert.deepEqual(await tripStage(db, [{ key: "fixup:app", reason: "third", evidence: [], at }]), ["fixup:app"]);
  assert.equal((await loadBreakerSince(db, ["fixup:app", "none"])).get("none"), "");
});

both("a push is recorded once per head and action, and two breaking repos trip the stage", async (db) => {
  const base = { action: "fixup-push", number: 1, from: "a", to: "b" };
  await addPushOutcomes(db, [{ ...base, repo: "app" }, { ...base, repo: "app" }, { ...base, repo: "lib" }, { action: "merge-batch", repo: "app", number: 1, from: "a", to: "z" }]);
  await addPushOutcomes(db, [{ ...base, repo: "app" }]);
  assert.equal((await listPushOutcomes(db, {})).length, 2);
  const q = queryDb(db);
  const red = JSON.stringify([{ name: "ci", state: "failure" }]);
  // Seed a green "before" for both repos, then break them: two repos in a window trip the instance-wide breaker.
  await q.run(q.k.updateTable("main.push_outcomes").set({ before_res: "green" }));
  await resolvePushes(db, [{ repo: "app", number: 1, head_oid: "b", checks: red }, { repo: "lib", number: 1, head_oid: "b", checks: red }]);
  const trips = await loadTrips(db);
  assert.ok(trips.has("fixup") && trips.has("fixup:app") === false, "the window holds one broken push per repo");
});

both("the approval writer skips a row already at that state and refuses an untracked repo", async (db) => {
  await addTrackedRepo(db, { name: "app", by: "op" });
  assert.equal(await setStepApproval(db, [{ repo: "app", step: "merge", on: true }], "op"), 1);
  assert.equal(await setStepApproval(db, [{ repo: "app", step: "merge", on: true }, { repo: "app", step: "ci", on: false }], "op"), 0);
  await assert.rejects(setStepApproval(db, [{ repo: "nope", step: "merge", on: true }], "op"), /not tracked/);
  assert.deepEqual((await listAudit(db, { actions: ["merge-approve", "ci-revoke"] })).map((r) => r.action), ["merge-approve"]);
  assert.equal(await setStepApproval(db, [{ repo: "app", step: "merge", on: false }], "op"), 1);
  assert.equal((await loadStepApprovals(db, ["app"])).size, 0);
});
