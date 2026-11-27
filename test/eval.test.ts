// The hourly self-evaluation: detectors group evidence by a stable cause key and a later run adds to the same group without
// counting what it saw before; filing makes one issue per cause and puts new evidence in one comment a day.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadEvalCauses, saveEvalCauses, type EvalCause } from "../src/data/eval/index.ts";
import { runEvalFiling } from "../src/eval/file.ts";
import type { EvalFinding } from "../src/eval/prompt.ts";
import { runEval, type EvalDeps } from "../src/eval/run.ts";
import { setEvalRepo } from "../src/eval/schedule.ts";
import type { Exec } from "../src/fixup/git.ts";
import { OPERATOR, world, type World } from "./world-db.ts";

let current: World | null = null;
afterEach(() => current?.close());

const H = 3_600_000;
const NOW = Date.parse("2026-11-27T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

async function queueCall(w: World, id: number, queuedSince: number): Promise<void> {
  await w.db.run(w.db.k.insertInto("remote_calls").values({
    id, step: "fixup", stage: 7, prompt_id: "fixup.patch", prompt_version: "v", tier: "top", effort: "high", asked_model: "opus", bundle: "{}", state: "queued",
    items: JSON.stringify([{ repo: "app", number: 4 }]), repo: "app", since: queuedSince, seen_at: NOW, queued_since: queuedSince, max_attempts: 2, timeout_ms: 1_200_000,
  }));
}

test("a stalled approved item and a call queued past an idle Task Runner make one group each, and a later run adds only new evidence", async () => {
  const w = current = await (await world()).repo();
  await setEvalRepo(w.db, "app", OPERATOR);
  await w.db.run(w.db.k.insertInto("item_workflows").values({
    repo: "app", number: 3, kind: "pr", entry: "review", state: "waiting", started_by: "maintainer", started_at: iso(NOW - 5 * H), started_via: "github",
    approved_by: "maintainer", approved_at: iso(NOW - 5 * H), step: "premerge", updated_at: iso(NOW - 3 * H),
  }));
  await w.db.run(w.db.k.insertInto("remote_helpers").values({ token_id: 1, login: "maintainer", readiness: "ready", harness: "claude", models: "{}", reserve: "{}", reported_at: NOW, slots: 2, busy: 0 }));
  await queueCall(w, 41, NOW - 45 * 60_000);

  const asked: string[] = [];
  const deps = (now: number): EvalDeps => ({
    now: () => now, runnerFreshMs: 10 * 60_000, checks: async () => [], checkout: async () => null,
    ask: async (input) => { asked.push(input.key); return { value: { real_defect: false, severity: "low", title: "Intended wait", cause: "A documented wait.", evidence: [], fix: "" }, model: "opus" }; },
  });
  const seen = async () => [...(await loadEvalCauses(w.db)).values()].map((c) => [c.key, c.seen, c.verdict]).sort();

  await runEval(w.db, { repo: "app", by: { operator: OPERATOR } }, () => {}, deps(NOW));
  assert.deepEqual(await seen(), [["queued-call:fixup", 1, "not-defect"], ["stalled-item:waiting:premerge", 1, "not-defect"]]);

  await queueCall(w, 42, NOW - 10 * 60_000);
  await w.db.run(w.db.k.updateTable("remote_helpers").set({ reported_at: NOW + H }));
  await runEval(w.db, { repo: "app", by: { operator: OPERATOR } }, () => {}, deps(NOW + H));
  assert.deepEqual(await seen(), [["queued-call:fixup", 2, "not-defect"], ["stalled-item:waiting:premerge", 1, "not-defect"]]);
  assert.deepEqual(asked.sort(), ["queued-call:fixup", "stalled-item:waiting:premerge"], "a group that grew within a day is not investigated again");
});

test("a real defect is filed once; new evidence becomes one comment a day on that issue, and private repos stay out of the text", async () => {
  const w = current = await (await world()).repo();
  await setEvalRepo(w.db, "app", OPERATOR);
  await w.db.run(w.db.k.insertInto("repos").values({ name: "secretcraft", visibility: "private", default_branch: "main" }));
  const finding: EvalFinding = { real_defect: true, severity: "high", title: "Fix-up call waits while a Task Runner idles", cause: "The claim refuses calls that need more time than the login has left.", evidence: [{ where: "src/remote/calls.ts:120", what: "refuses the claim" }], fix: "Refresh the login before refusing." };
  const cause = (seen: number, n: number): EvalCause => ({
    key: "queued-call:fixup", detector: "queued-call-idle-runner", summary: "s", state: "investigated", firstSeen: iso(NOW - 2 * H), lastSeen: iso(NOW), seen,
    evidence: Array.from({ length: n }, (_, i) => ({ id: `call:${100 + i}`, at: iso(NOW - i * 60_000), note: "fixup.patch queued", ref: { repo: i % 2 ? "secretcraft" : "app", number: 4 + i } })),
    investigatedAt: iso(NOW), investigatedSeen: seen, verdict: "defect", failures: 0, finding, model: "claude-opus-5-5", runId: "r", issueNumber: null, filedAt: null, reportedSeen: 0, commentedAt: null, attempts: 0, note: null,
  });
  await saveEvalCauses(w.db, [cause(3, 3)]);

  const gh: { args: string[]; input: string }[] = [];
  const exec: Exec = async (_cmd, args, o) => {
    gh.push({ args, input: String((o as { input?: string } | undefined)?.input ?? "") });
    if (args[0] === "issue" && args[1] === "create") return { code: 0, stdout: "https://github.com/storytold/app/issues/501\n", stderr: "" };
    if (args[0] === "issue" && args[1] === "comment") return { code: 0, stdout: "https://github.com/storytold/app/issues/501#issuecomment-1\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const file = (now: number) => runEvalFiling(w.db, { repo: "app", by: { operator: OPERATOR } }, () => {}, { exec, now: () => new Date(now) });
  const calls = (sub: string) => gh.filter((c) => c.args[0] === "issue" && c.args[1] === sub);

  assert.deepEqual((await file(NOW)).filed, [501]);
  const created = calls("create")[0]!;
  assert.ok(created.args.includes("autocraft-eval"));
  assert.ok(!created.input.includes("secretcraft") && created.input.includes("src/remote/calls.ts:120"));

  await saveEvalCauses(w.db, [{ ...(await loadEvalCauses(w.db)).get("queued-call:fixup")!, seen: 5, evidence: cause(5, 5).evidence }]);
  await file(NOW + H);
  assert.equal(calls("comment").length, 0, "no second post on the issue within a day");
  await file(NOW + 25 * H);
  await file(NOW + 26 * H);
  assert.deepEqual([calls("create").length, calls("comment").length], [1, 1]);
  assert.ok(!calls("comment")[0]!.input.includes("secretcraft"));
});

test("posted text carries no known login (bare, mentioned, in code or a path), home directory, internal or known host, private repo, unknown mention or e-mail address", async () => {
  const w = current = await (await world()).repo();
  await setEvalRepo(w.db, "app", OPERATOR);
  await w.db.run(w.db.k.insertInto("remote_helpers").values({ token_id: 7, login: "dana-k", readiness: "ready", harness: "claude", models: "{}", reserve: "{}", reported_at: NOW, slots: 1, busy: 0 }));
  await w.db.run(w.db.k.insertInto("access").values({ login: "bob-dev", role: "maintainer" }));
  await w.db.run(w.db.k.insertInto("repos").values({ name: "secretrepo", visibility: "private", default_branch: "main" }));
  const baseUrl = process.env.AUTOCRAFT_BASE_URL;
  process.env.AUTOCRAFT_BASE_URL = "https://dash.example-host.dev";
  const finding: EvalFinding = {
    real_defect: true, severity: "medium", title: "Approval by dana-k never reaches the queue",
    cause: "The answer from dana-k (mentioned as @dana-k, then @someone-else) is read by `src/core/answer.ts`; write to dana@example.org or see http://runner.internal:8080/jobs/9.",
    evidence: [{ where: "src/core/answer.ts:40", what: "drops the answer of dana-k" }],
    fix: "Queue the answer. Seen as `@dana-k` in /home/dana-k/x, /Users/jdoe/y and C:\\Users\\jdoe\\z, users/bob-dev, dana-k/pub, github.com/dana-k/x, k8s.example-host.dev, autocraft-db.craft.svc.cluster.local:5432 and `secretrepo.git`.",
  };
  await saveEvalCauses(w.db, [{
    key: "answer-ran-nothing", detector: "answer-ran-nothing", summary: "s", state: "investigated", firstSeen: iso(NOW - H), lastSeen: iso(NOW), seen: 1,
    evidence: [{ id: "answer:3", at: iso(NOW), note: "answered by dana-k", ref: { repo: "app", number: 3 } }],
    investigatedAt: iso(NOW), investigatedSeen: 1, verdict: "defect", failures: 0, finding, model: "claude-opus-5-5", runId: "r", issueNumber: null, filedAt: null, reportedSeen: 0, commentedAt: null, attempts: 0, note: null,
  }]);
  const posted: string[] = [];
  const exec: Exec = async (_cmd, args, o) => {
    if (args[0] === "issue" && args[1] === "create") { posted.push(args.join(" "), String((o as { input?: string } | undefined)?.input ?? "")); return { code: 0, stdout: "https://github.com/storytold/app/issues/9\n", stderr: "" }; }
    return { code: 0, stdout: "", stderr: "" };
  };
  try {
    assert.deepEqual((await runEvalFiling(w.db, { repo: "app", by: { operator: OPERATOR } }, () => {}, { exec, now: () => new Date(NOW) })).filed, [9]);
  } finally {
    if (baseUrl === undefined) delete process.env.AUTOCRAFT_BASE_URL; else process.env.AUTOCRAFT_BASE_URL = baseUrl;
  }
  const text = posted.join("\n");
  for (const gone of ["dana-k", "bob-dev", "jdoe", "someone-else", "@", "dana@example.org", "runner.internal", "example-host", "svc.cluster", "secretrepo"]) assert.ok(!text.includes(gone), `${gone} is posted`);
  assert.ok(text.includes("a Task Runner owner") && text.includes("src/core/answer.ts:40"));
});
