import assert from "node:assert/strict";
import { test } from "node:test";
import { insertRun, finishRun } from "../src/agents/runs.ts";
import { barOf } from "../src/dash/api/item-bar.ts";
import { loadItemPage } from "../src/data/views/item-page.ts";
import { classifiersReport, cost, disagreements } from "../src/dash/api/insight.ts";
import type { Req } from "../src/dash/types.ts";
import { connectDb } from "./helpers/raw-db.ts";

const req = (query: Record<string, string> = {}): Req => ({
  method: "GET", path: "", params: {}, query: new URLSearchParams(query), form: new URLSearchParams(), user: { login: "op", role: "operator", canWrite: async () => true, canRead: async () => true },
  csrf: "", nonce: "",
});

test("the cost report totals token use per stage, repo, user and run, and narrows to one run", async () => {
  const db = await connectDb(":memory:");
  const use = (run_id: string, stage: string, model: string, repo: string | null, input: number, usd: number, at: string) =>
    ({ run_id, agent: `${stage}-${model}-${repo}`, stage, model, repo, items: 2, input_tokens: input, output_tokens: 10, cache_read_tokens: null, cache_write_tokens: null, started_at: at, ended_at: at, cost_usd: usd });
  await db.run(db.k.insertInto("token_usage").values([
    use("r1", "classify", "haiku", null, 100, 0.01, "2026-01-01T10:00:00Z"),
    use("r1", "review", "opus", "app", 500, 0.5, "2026-01-01T11:00:00Z"),
    use("r2", "review", "opus", "lib", 50, 0.1, "2026-01-02T11:00:00Z"),
  ]));
  const call = { step: "s", stage: 1, prompt_id: "p", prompt_version: "1", provider: "claude", model: "opus", state: "done" };
  await db.run(db.k.insertInto("agent_runs").values([
    { ...call, started_at: "2026-01-01T10:30:00Z", user_login: "alice", item_count: 3, cost_usd: 0.2 },
    { ...call, started_at: "2026-01-01T10:40:00Z", user_login: null, item_count: 1, cost_usd: 0.9 },
    { ...call, started_at: "2026-01-03T10:00:00Z", user_login: "bob", item_count: 1, cost_usd: 0.1 },
  ]));

  const all = await cost(db, req());
  assert.equal(all.total.calls, 3);
  assert.equal(all.total.input, 650);
  assert.ok(Math.abs((all.total.usd ?? 0) - 0.61) < 1e-9);
  assert.deepEqual(all.runs.map((r) => r.id), ["r2", "r1"], "newest run first");
  assert.deepEqual(all.stages.map((s) => [s.stage, s.model, s.calls]), [["classify", "haiku", 1], ["review", "opus", 2]]);
  assert.deepEqual(all.repos.map((r) => r.repo), ["app", "lib"], "calls without a repo are not a repo row; most tokens first");
  assert.deepEqual(all.users.map((u) => u.login), ["alice", "bob", null], "most spend first, calls on server accounts last");

  const one = await cost(db, req({ run: "r1" }));
  assert.equal(one.total.calls, 2);
  assert.deepEqual(one.repos.map((r) => r.repo), ["app"]);
  assert.deepEqual(one.users.map((u) => u.login), ["alice", null], "only calls started within the run's span");
  assert.equal(one.series.length, 2, "hourly buckets for a short run");
});

test("classifier reports pair the classifiers of a run and list their disagreements", async () => {
  const db = await connectDb(":memory:");
  const row = (number: number, classifier: string, type_label: string, top: number | null) =>
    ({ repo: "app", number, classifier, run_id: "run1", at: "2026-01-01T00:00:00Z", type_label, flags: '["security"]', probs: top === null ? null : JSON.stringify({ top }) });
  await db.run(db.k.insertInto("classifications").values([
    row(1, "haiku", "bug", 0.95), row(1, "sonnet", "bug", null),
    row(2, "haiku", "feature", 0.2), row(2, "sonnet", "bug", null),
  ]));
  await db.run(db.k.insertInto("items").values([
    { repo: "app", number: 1, kind: "pr", state: "OPEN", title: "one" },
    { repo: "app", number: 2, kind: "issue", state: "OPEN", title: "two" },
  ]));
  const r = await classifiersReport(db, req());
  assert.equal(r.run, "run1");
  assert.deepEqual([r.a, r.b], ["haiku", "sonnet"], "the classifier with probabilities goes first");
  assert.deepEqual([r.overall.n, r.overall.agree], [2, 1]);
  assert.equal(r.flags[0]!.both, 2);

  const d = await disagreements(db, req({ run: "run1", a: "haiku", b: "sonnet" }));
  assert.equal(d.total, 1);
  assert.deepEqual(d.rows.map((x) => [x.number, x.title, x.a.label, x.b.label, x.a.prob]), [[2, "two", "feature", "bug", 0.2]]);
  assert.equal((await disagreements(db, req({ run: "run1", a: "haiku", b: "sonnet", label: "security" }))).total, 0);
});

test("an item's status bar queues behind earlier jobs of the step, shows a failed fix-up and a done verification, and sums the item's model costs", async () => {
  const db = await connectDb(":memory:");
  const job = (n: number, state: string) => ({ step: "opus-review", params: JSON.stringify({ repo: "app", number: n }), requested_by: "pipeline", requested_at: "2026-01-01T00:00:00Z", state, repo: "app" });
  await db.run(db.k.insertInto("jobs").values([job(1, "queued"), job(2, "queued"), job(5, "queued"), job(6, "queued")]));
  await db.run(db.k.insertInto("fixups").values({ repo: "app", number: 5, from_head: "h1", state: "failed", reason: "refused: too big", created_at: "2026-01-01T01:00:00Z", attempt: 1 }));
  await db.run(db.k.insertInto("verifications").values({ repo: "app", number: 5, head_sha: "h1", kind: "k", reason: "r", state: "passed", created_at: "2026-01-01T02:00:00Z" }));
  const run = await insertRun(db, { jobId: null, step: "opus-review", stage: 5, promptId: "p", promptVersion: "1", provider: "claude", model: "opus", items: [{ repo: "app", number: 5 }], prompt: "x" });
  await finishRun(db, run, { state: "done", output: "o", costUsd: 0.25 });
  const c = { db, repo: "app", n: 5, ref: "app#5", own: new Set<string>(), box: "", staff: true, veiled: false, operator: true, hidden: [] };
  const facts = await loadItemPage(db, { staff: true, operator: true, hidden: [] }, { repo: "app", number: 5 }, null);
  const bar = barOf(c, { kind: "pr", state: "open", mergedAt: null, pipelineOn: true }, { phase: "Review", waiting: null, next: null, since: "2026-01-01T00:00:00Z" }, facts);
  assert.match(bar.headline.text, /#3 in line/, "two queued jobs of the step ahead");
  const state = (stage: string) => bar.steps.find((x) => x.stage === stage);
  assert.equal(state("fixup")?.state, "failed");
  assert.equal(state("verify")?.state, "done");
  assert.equal(state("review")?.costUsd, 0.25);
});
