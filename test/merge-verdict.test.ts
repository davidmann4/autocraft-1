// Whether a pull request merges is one answer: the plan's permission, the merge step's check, the guard right before the write and the
// batch that would carry it. Then what the merge step and the batches do with a refused one.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mayRun } from "../src/core/authority.ts";
import { decidePr } from "../src/core/decide.ts";
import { allows, memberRefusal } from "../src/core/guard.ts";
import { savePermissions } from "../src/data/access/index.ts";
import { startWorkflows } from "../src/data/workflow/index.ts";
import type { LaneDeps } from "../src/github/user-lane.ts";
import { mergeVerdict } from "../src/merge/approval.ts";
import { runBatches, type BatchDeps } from "../src/merge/batch.ts";
import { runMerge } from "../src/merge/index.ts";
import type { Querier } from "../src/mirror.ts";
import { factsOf, greenRows, headOf, prng, randomPrRows, rnd, type PrRows } from "./random-pr.ts";
import { T0, T1, world, type World } from "./world-db.ts";

let current: World | undefined;
afterEach(() => current?.close());
const quiet = () => {};
const MIRA = "mira";

test("plan, merge step, guard and batch give one verdict, and a refused merge passes none of them", () => {
  const seed = Number(process.env.INVARIANT_SEED ?? (Date.now() & 0x7fffffff)), x = rnd(prng(seed));
  // Half of the cases are a green PR with a few things wrong, so that merges that pass are among them.
  const nearGreen = (): PrRows => greenRows({ workflow: x.bool(0.3) ? null : greenRows().workflow, mergeWaits: x.bool(0.2), draft: x.bool(0.1), batch: x.pick([null, null, "in-batch", "batch-checking"] as const),
    pipelineOn: x.bool(0.9), tripped: x.bool(0.1) ? { merge: "main is red" } : {}, implementation: x.bool(0.2) ? { state: "revising", revised: false, standing: "yes" } : null });
  let merged = 0, batched = 0;
  for (let i = 0; i < 1500; i++) {
    const w = i % 2 ? randomPrRows(x) : nearGreen(), f = factsOf(w), head = headOf(w), plan = decidePr(f);
    const at = `INVARIANT_SEED=${seed} case ${i}: ${JSON.stringify(w)}`;
    for (const by of ["pipeline", { operator: "op" }] as const) {
      const action = plan.actions.find((a) => a.kind === "merge" && a.head === head);
      const planned = action ? mayRun({ facts: f, action }, by) : null;
      const guarded = allows(f, { kind: "merge", head }, by), member = allows(f, { kind: "merge", head, batch: true }, by);
      const verdict = mergeVerdict(f, head), batch = mergeVerdict(f, head, { batch: true });
      assert.equal(guarded.ok, !!planned?.ok, `the guard and the plan: ${at}`);
      if (guarded.ok) { merged++; assert.deepEqual(verdict, guarded, `the guard and the merge step: ${at}`); }
      if (member.ok) { batched++; assert.deepEqual(batch, member, `the batch guard and the batch: ${at}`); assert.equal(memberRefusal(f), null, at); }
      if (batch.ok) assert.ok(verdict.ok, at);
    }
    assert.equal(mergeVerdict(f, "another").ok, false, at);
  }
  assert.ok(merged > 20 && batched > 20, `${merged} merges and ${batched} batch members passed`);
});

/** PRs that the rule would merge, all ready. */
async function ready(...prs: number[]): Promise<World> {
  const w = current = await (await world()).repo();
  for (const n of prs) await (await (await (await w.pr(n)).review(n)).verified(n)).premerge(n, "clean");
  return w;
}
const lane: LaneDeps = { vault: { userToken: async () => ({ ok: true, access: "token" }) }, permission: async () => "write" };
/** GitHub's answers changed on their way. */
const answers = (w: World, change: (d: Record<string, any>) => void): Querier => ({ spent: 0, remaining: 5000, query: async (q, v) => { const d = await w.gh.querier.query(q, v); change(d as Record<string, any>); return d; } });
/** GitHub says that nobody has write access any more. */
const noWrite: NonNullable<BatchDeps["permission"]> = async (db, login, repo) => {
  await savePermissions(db, [{ login, repo, permission: "read", checkedAt: new Date().toISOString() }]);
  return { kind: "ok", permission: "read" };
};
const aged = (w: World) => w.db.run(w.db.k.updateTable("repo_permissions").set({ checked_at: new Date(Date.now() - 30 * 60_000).toISOString() }));
/** Each batch's members; `!` after the ids of one that ended. */
const batchesOf = async (w: World) => await Promise.all((await w.rows("SELECT id, state FROM merge_batches ORDER BY id")).map(async (b) =>
  (await w.rows("SELECT number FROM merge_batch_prs WHERE batch_id = ? ORDER BY number", b.id as number)).map((m) => m.number).join() + (b.state === "superseded" ? "!" : "")));
/** The app's pushes are not faked: the batch PR counts as opened. */
const opened = (w: World) => w.db.run(w.db.k.updateTable("merge_batches").set({ state: "open", pr_number: 900, pr_url: "u", fork: "bot/app" }));

test("a batch leaves out the PR of an approver without write access, when it starts and when it lands, and holds nothing", async () => {
  const w = await ready(1, 2, 3);
  await (await (await w.acting(MIRA)).workflow(2, { by: MIRA })).handedOver(2);
  await aged(w);
  const deps = w.gh.batchDeps();
  await runBatches(w.db, { repo: "app" }, quiet, { ...deps, permission: noWrite });
  assert.deepEqual(await batchesOf(w), ["1,3"]);
  w.close();

  const v = await ready(1, 2, 3);
  await (await (await v.acting(MIRA)).workflow(2, { by: MIRA })).handedOver(2);
  const later = v.gh.batchDeps();
  await runBatches(v.db, { repo: "app" }, quiet, later);
  assert.deepEqual(await batchesOf(v), ["1,2,3"]);
  await opened(v);
  await aged(v);
  await runBatches(v.db, { repo: "app" }, quiet, { ...later, permission: noWrite });
  assert.deepEqual(await batchesOf(v), ["1,2,3!", "1,3"]);
  assert.deepEqual(v.gh.writesOf("merge"), []);
  assert.deepEqual((await v.rows("SELECT state FROM preapprovals")).map((r) => r.state), ["queued"], "the approval is left to the question that asks for another's");
});

test("a batch goes on without a member whose implementation session revises it", async () => {
  const w = await ready(1, 2);
  await (await w.acting(MIRA)).issue(7);
  const now = new Date().toISOString();
  await w.db.run(w.db.k.insertInto("main.implementations").values({ repo: "app", number: 7, attempt: 1, state: "pr-opened", pr_number: 2, text_hash: "h", queued_by: MIRA, created_at: now, updated_at: now } as never));
  const id = (await startWorkflows(w.db, [{ repo: "app", number: 7, kind: "issue", entry: "implement", weight: 5, startedBy: MIRA, startedVia: "dashboard", baseHead: null, at: T0, approvedBy: MIRA, approvedVia: "dashboard" }])).get("app#7")!;
  await w.db.run(w.db.k.insertInto("preapprovals").values({ repo: "app", number: 2, by: MIRA, at: T1, instructions: "", state: "queued", from_head: "sha2", head: "sha2", updated_at: T1, workflow_id: id }));
  const deps = w.gh.batchDeps();
  await runBatches(w.db, { repo: "app" }, quiet, deps);
  assert.deepEqual(await batchesOf(w), ["1,2"]);
  await opened(w);
  await w.db.run(w.db.k.updateTable("main.implementations").set({ state: "revising" }));
  await runBatches(w.db, { repo: "app" }, quiet, deps);
  assert.deepEqual([await batchesOf(w), w.gh.writesOf("merge")], [["1,2!", "1"], []]);
});

test("a tripped breaker of the merge keeps an open batch and starts none", async () => {
  const w = await ready(1, 2);
  const deps = w.gh.batchDeps();
  const trip = async (active: number) => {
    await w.db.prepare("DELETE FROM stage_trips").run();
    await w.db.prepare("INSERT INTO stage_trips (stage, reason, evidence, tripped_at, active) VALUES ('merge:app', 'main is red', '[]', ?, ?)").run(new Date().toISOString(), active);
  };
  await trip(1);
  await runBatches(w.db, { repo: "app" }, quiet, deps);
  assert.deepEqual(await batchesOf(w), []);
  await trip(0);
  await runBatches(w.db, { repo: "app" }, quiet, deps);
  await trip(1);
  await runBatches(w.db, { repo: "app" }, quiet, deps);
  assert.deepEqual([await batchesOf(w), w.gh.writesOf("merge")], [["1,2"], []]);
});

test("nothing merges in a repo without CI, not even what a person approved", async () => {
  const w = await ready(1);
  await w.db.run(w.db.k.updateTable("pr_checks").set({ overall: "none", checks: "[]" }));
  await (await (await w.acting(MIRA)).workflow(1, { by: MIRA })).handedOver(1);
  const noChecks = answers(w, (d) => { if (d.repository?.pr1) d.repository.pr1.commits.nodes[0].commit.statusCheckRollup = null; });
  await runMerge(w.db, { repo: "app", dryRun: false }, quiet, { ...w.gh.mergeDeps(), querier: noChecks, lane });
  assert.deepEqual(w.gh.writesOf("merge"), []);
});

test("a PR merges only into the default branch, also when its review read the diff against another one", async () => {
  const w = await ready(1);
  await w.db.run(w.db.k.updateTable("main.items").set({ base_ref: "release" }));
  await w.db.run(w.db.k.updateTable("main.opus_reviews").set({ base_ref: "release" }));
  const aimed = answers(w, (d) => { if (d.repository?.pullRequest?.baseRefName) d.repository.pullRequest.baseRefName = "release"; });
  await runMerge(w.db, { repo: "app", dryRun: false }, quiet, { ...w.gh.mergeDeps(), querier: aimed });
  assert.deepEqual([w.gh.writesOf("merge"), await w.rows("SELECT * FROM merges")], [[], []]);
});
