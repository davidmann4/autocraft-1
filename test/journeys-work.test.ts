// Journeys: a PR or issue goes through the real planner pass, the real executors and the real guard, with GitHub and the
// models faked (test/world-db.ts). Each test asserts outcomes: rows in the database and the writes that reached GitHub.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, test } from "node:test";
import { withConfig } from "../src/data/control/index.ts";
import { MAINTAINER_ANSWER_WAIT } from "../src/core/decide.ts";
import { gates } from "../src/core/gates.ts";
import { guardItem, guardRepo } from "../src/core/guard.ts";
import { writePlanCache } from "../src/core/plan-cache.ts";
import { implementMay, implementRefusal } from "../src/implement/gate.ts";
import { computeLiveness } from "../src/liveness.ts";
import { runCifix } from "../src/cifix/index.ts";
import { runFixup, type FixupDeps } from "../src/fixup/index.ts";
import { selectFixups } from "../src/fixup/select.ts";
import { setFeature } from "../src/build/features.ts";
import { runSingles } from "../src/merge/single.ts";
import { premergeCandidates } from "../src/premerge/review.ts";
import { savePremerge } from "../src/premerge/store.ts";
import type { LaneDeps } from "../src/github/user-lane.ts";
import { advancePreapprovals } from "../src/preapproval/index.ts";
import { advanceWorkflows } from "../src/workflow/advance.ts";
import { liveWorkflow } from "../src/workflow/store.ts";
import { LANES, planCtx } from "../src/runner/autopilot.ts";
import { checkRequest } from "../src/runner/jobs.ts";
import { runCommand } from "../src/workflow/apply.ts";
import { parse } from "../src/workflow/parse.ts";
import { OPERATOR, T1, tmpdir, untilQuiet, world, type World } from "./world-db.ts";
import { reportingTaskRunner } from "./fake-runner.ts";
import { DIFF, endLint, fresh, gitWorld, keep, quiet, sh } from "./journeys-world.ts";

describe("lint findings resume the patch session", () => {
  const edit = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,2 +1,2 @@\n-fn a() {}\n-fn main() { a(); }\n+fn b() {}\n+fn main() { b(); }\n";
  /** Round 1 stores the patch and its session; clippy finds something; round 2 runs `minutes` later. */
  const second = async (minutes: number) => {
    const git = gitWorld(1);
    const w = await (await (await fresh()).pr(1, { head: git.head })).review(1, { verdict: "take-fix" });
    await reportingTaskRunner(w.db);
    const deps = git.deps(w);
    let clock = Date.parse(T1);
    deps.now = () => new Date(clock);
    const stores = [tmpdir("session-a"), tmpdir("session-b")];
    const asked: { previous?: unknown; resume?: { session: { id: string }; message: string } }[] = [];
    deps.ask = async (_db, input, _checkout, _tool, session) => {
      const n = asked.push({ previous: (input[0] as { previous?: unknown }).previous, resume: session?.resume });
      session!.kept = { id: `s${n}`, dir: stores[session?.resume ? 0 : n - 1]!, account: "a", checkout: "/c" };
      return n === 1 ? git.patch : edit;
    };
    await runFixup(w.db, { repo: "app", dryRun: false }, quiet, deps);
    const stored = async () => JSON.parse((await w.db.get(w.db.k.selectFrom("fixups").select("session")))!.session!) as Record<string, { id: string; dir: string }>;
    assert.equal((await stored())[""]!.id, "s1");
    await endLint(w, ((await w.rows("SELECT id FROM build_tasks"))[0] as { id: number }).id, { diagnostics: [{ line: 1 }] });
    clock += minutes * 60_000;
    await runFixup(w.db, { repo: "app", dryRun: false }, quiet, deps);
    return { asked, stored, stores };
  };

  test("findings within 60 minutes continue the stored session with the findings", async () => {
    const { asked, stored, stores } = await second(59);
    assert.equal(asked[1]!.resume!.session.id, "s1");
    assert.match(asked[1]!.resume!.message, /needless at line 1/);
    assert.equal((await stored())[""]!.dir, stores[0]);
    assert.equal(existsSync(stores[0]!), true);
  });

  test("findings after 60 minutes start a new call with the earlier patch, and the old session is removed", async () => {
    const { asked, stored, stores } = await second(61);
    assert.equal(asked[1]!.resume, undefined);
    assert.match(JSON.stringify(asked[1]!.previous), /needless at line 1/);
    assert.equal((await stored())[""]!.id, "s2");
    assert.equal(existsSync(stores[0]!), false);
    assert.equal(existsSync(stores[1]!), true);
  });
});

describe("conflict resolution lint", () => {
  const resolved = (line: string) => JSON.stringify({ sections: [{ id: 1, content: line }] });
  const setup = async () => {
    const git = gitWorld(1, undefined, true);
    const w = await (await (await (await fresh()).pr(1, { head: git.head, mergeable: "CONFLICTING" })).review(1, { verdict: "take" })).verified(1);
    await w.db.run(w.db.k.updateTable("items").set({ base_ref: "main" }).where("repo", "=", "app").where("number", "=", 1));
    const deps = git.deps(w);
    const asked: { previous?: { findings: string[] } }[] = [];
    const answers = ["// both\nfn main() { a(); b(); }\n", "// both\nfn main() { a(); a(); }\n"];
    deps.resolve = async (_db, input) => { asked.push(input[0] as (typeof asked)[number]); return resolved(answers[asked.length - 1]!); };
    return { git, w, deps, asked };
  };
  const run = (w: World, deps: FixupDeps) => runFixup(w.db, { repo: "app", dryRun: false }, process.env.DBG ? console.log : quiet, deps);
  const lastTask = async (w: World) => ((await w.rows("SELECT id FROM build_tasks ORDER BY id DESC LIMIT 1"))[0] as { id: number }).id;

  test("clippy findings on a resolution go back to the model; the clean second resolution is merged in", async () => {
    const { git, w, deps, asked } = await setup();
    assert.deepEqual((await w.prPlan(1)).actions.map((a) => [a.kind, a.params?.bucket]), [["conflict", "merge"]]);
    assert.deepEqual((await run(w, deps)).pushed, []);
    assert.deepEqual(await w.db.all(w.db.k.selectFrom("conflict_merges").select(["state", "lint_round"])), [{ state: "linting", lint_round: 1 }]);
    await endLint(w, await lastTask(w), { diagnostics: [{ line: 2 }] });
    assert.deepEqual((await w.prPlan(1)).actions.map((a) => [a.kind, a.params?.bucket]), [["lint", "conflict"]]);

    assert.deepEqual((await run(w, deps)).pushed, []);
    assert.equal(asked.length, 2);
    assert.match(asked[1]!.previous!.findings[0]!, /needless at line 2/);
    assert.deepEqual(await w.db.all(w.db.k.selectFrom("conflict_merges").select(["state", "lint_round"])), [{ state: "linting", lint_round: 2 }]);

    await endLint(w, await lastTask(w));
    assert.deepEqual((await run(w, deps)).pushed, ["app#1"]);
    const pushed = git.branchHead();
    assert.equal(sh(git.fork, "show", `${pushed}:src/lib.rs`), "fn a() {}\n// both\nfn main() { a(); a(); }");
    assert.deepEqual(await w.db.all(w.db.k.selectFrom("conflict_merges").select(["state", "to_head"])), [{ state: "merged", to_head: pushed }]);
  });

  test("findings after the second lint round fail the try with the reason", async () => {
    const { git, w, deps, asked } = await setup();
    await run(w, deps);
    await endLint(w, await lastTask(w), { diagnostics: [{ line: 2 }] });
    await run(w, deps);
    await endLint(w, await lastTask(w), { diagnostics: [{ line: 2 }] });
    const s = await run(w, deps);
    assert.deepEqual(s.pushed, []);
    assert.equal(asked.length, 2);
    assert.deepEqual(git.pushes, []);
    const row = (await w.db.get(w.db.k.selectFrom("conflict_merges").select(["state", "reason"])))!;
    assert.equal(row.state, "rejected");
    assert.match(row.reason!, /clippy findings remain after 2 rounds: needless/);
  });
});

describe("patch model build tool", () => {
  test("the model checks its patch with clippy, fixes the finding and re-checks; the harness's lint then passes on the first round", async () => {
    const git = gitWorld(1);
    const w = await (await (await fresh()).pr(1, { head: git.head })).review(1, { verdict: "take-fix" });
    await reportingTaskRunner(w.db);
    const dirty = git.patch.replace("+fn b() {}\n", "+fn b() { return; }\n");
    assert.notEqual(dirty, git.patch);
    const deps = git.deps(w);
    const outcomes: string[] = [];
    let asked = 0;
    // The fake worker: a queued task of a patch with `return;` has a clippy finding on line 1, any other is clean.
    let busy = false;
    const worker = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        for (const t of await w.rows("SELECT id, patch FROM build_tasks WHERE state = 'queued'") as { id: number; patch: string }[]) await endLint(w, t.id, { diagnostics: t.patch.includes("return;") ? [{ line: 1 }] : [] });
      } finally {
        busy = false;
      }
    }, 5);
    deps.ask = async (_db, _input, _checkout, tool) => {
      asked++;
      tool!.pollMs = 5;
      const first = await tool!.run({ patch: dirty, command: "clippy" }, null);
      outcomes.push(first.text);
      const second = await tool!.run({ patch: git.patch, command: "clippy" }, null);
      outcomes.push(second.text);
      clearInterval(worker);
      return git.patch;
    };
    const first = await runFixup(w.db, { repo: "app", dryRun: false }, quiet, deps).finally(() => clearInterval(worker));
    assert.equal(asked, 1);
    assert.match(outcomes[0]!, /clippy: 1 finding/);
    assert.match(outcomes[1]!, /clippy: 0 findings/);
    assert.deepEqual(await w.rows("SELECT step, command, outcome FROM model_checks ORDER BY id"), [
      { step: "fixup", command: "clippy", outcome: "1 finding" }, { step: "fixup", command: "clippy", outcome: "0 findings" },
    ]);

    // The harness's own lint task is the third task; it is clean, so the first round pushes.
    assert.deepEqual(first.pushed, []);
    const lint = ((await w.rows("SELECT id FROM build_tasks ORDER BY id DESC LIMIT 1"))[0] as { id: number }).id;
    assert.equal(((await w.rows("SELECT COUNT(*) AS n FROM build_tasks"))[0] as { n: number }).n, 3);
    await endLint(w, lint);
    const second = await runFixup(w.db, { repo: "app", dryRun: false }, quiet, deps);
    assert.deepEqual(second.pushed, ["app#1"]);
    assert.equal(asked, 1);
    assert.deepEqual(await w.db.all(w.db.k.selectFrom("fixups").select(["state", "lint_round"])), [{ state: "pushed", lint_round: 1 }]);
  });
});

describe("CI fix journey", () => {
  test("a PR whose CI fails gets a fix pushed to its branch for the reviewed head", async () => {
    const git = gitWorld(1, "fn a() {}\nfn main() { b(); }\n");
    const w = await (await (await fresh()).pr(1, { head: git.head, ci: "failure" })).review(1);
    await reportingTaskRunner(w.db);
    assert.equal((await w.prPlan(1)).state, "ci-failed");
    assert.deepEqual((await w.prPlan(1)).actions.map((a) => [a.kind, a.params?.bucket, a.head]), [["cifix", "work", git.head]]);

    const s0 = await runCifix(w.db, { repo: "app", dryRun: false }, quiet, git.cifixDeps(w));
    assert.deepEqual(s0.pushed, []);
    assert.deepEqual(await w.db.all(w.db.k.selectFrom("ci_fixes").select("state")), [{ state: "linting" }]);
    await endLint(w, ((await w.rows("SELECT id FROM build_tasks"))[0] as { id: number }).id);
    const s = await runCifix(w.db, { repo: "app", dryRun: false }, quiet, git.cifixDeps(w));
    assert.deepEqual(s.pushed, ["app#1"]);
    const pushed = git.branchHead();
    assert.notEqual(pushed, git.head);
    assert.deepEqual(git.pushes, [{ lease: git.head, to: pushed }]);
    assert.deepEqual(await w.db.all(w.db.k.selectFrom("ci_fixes").select(["kind", "state", "head", "to_head"])), [{ kind: "code", state: "pushed", head: git.head, to_head: pushed }]);
    assert.equal(w.gh.writesOf("merge").length, 0);
  });
});

describe("a repo with no step approvals", () => {
  /** No approvals; `mira` and the operator may act. The Task Runner takes every call. */
  const unapproved = async (): Promise<World> => {
    const w = keep(await (await (await world()).repo(["merge", "push", "comment", "ci", "fixissue"])).acting("mira", OPERATOR));
    await reportingTaskRunner(w.db);
    return w;
  };
  const say = async (w: World, text: string, n: number, login = "mira") => {
    const r = await runCommand(w.db, { login, canWrite: async () => true }, "dashboard", { parsed: parse(text), items: [{ repo: "app", number: n }] });
    assert.equal(r.items[0]!.outcome, "run", r.lines.join());
    await untilQuiet(w.db, [() => advanceWorkflows(w.db), () => advancePreapprovals(w.db)], 3);
  };
  /** The jobs the lane proposes, each taken by the queue's own check. */
  const jobs = async (w: World, lane: string): Promise<string[]> => {
    const found = await LANES.find((l) => l.name === lane)!.detect(w.db, await planCtx(w.db));
    for (const c of found) await checkRequest(w.db, c.step, c.params);
    return found.map((c) => c.step);
  };
  const actions = async (w: World, n: number) => (await w.prPlan(n)).actions.map((a) => [a.kind, a.params?.bucket, a.params?.source].filter(Boolean).join(":"));
  const lastTask = async (w: World) => ((await w.rows("SELECT id FROM build_tasks ORDER BY id DESC LIMIT 1"))[0] as { id: number }).id;

  test("a merge a person started runs as them; a PR nobody started is left alone, also when the same job works the repo", async () => {
    const w = await unapproved();
    // #1 nobody started: ready by the rule. #2 is started.
    for (const n of [1, 2]) await (await (await (await w.pr(n)).review(n)).verified(n)).premerge(n, "clean");
    assert.equal((await w.prPlan(1)).state, "ready");
    assert.deepEqual(await jobs(w, "merge"), []);
    await say(w, "merge", 2);
    assert.deepEqual(await actions(w, 2), ["merge"]);
    assert.deepEqual(await jobs(w, "merge"), ["merge"]);
    const lane: LaneDeps = { vault: { userToken: async () => ({ ok: true, access: "token" }) }, permission: async () => "write" };
    const s = await runSingles(w.db, { repo: "app", by: "pipeline" }, quiet, { ...w.gh.mergeDeps(), lane }, async () => ({ ok: true, text: DIFF }));
    assert.deepEqual(s?.merged, ["app#2"]);
    assert.deepEqual(w.gh.writesOf("merge").map((x) => x.number), [2]);
    assert.deepEqual(await jobs(w, "merge"), []);
  });

  test("the checks of a merge a person started are read again while its CI runs; a PR nobody started is not polled", async () => {
    const w = await unapproved();
    await (await w.pr(1, { ci: "pending" })).review(1);
    assert.equal((await w.prPlan(1)).state, "waiting-ci");
    assert.deepEqual(await jobs(w, "merge"), []);
    await say(w, "merge", 1);
    assert.equal((await w.prPlan(1)).state, "waiting-ci");
    assert.deepEqual(await jobs(w, "merge"), ["checks"]);
  });

  test("the failed pre-merge review of an approved PR wakes the planner for its retry", async () => {
    const w = await unapproved();
    await (await (await w.pr(1)).review(1)).verified(1);
    await w.workflow(1, { by: "mira" });
    const at = Date.now();
    await savePremerge(w.db, { repo: "app", number: 1, head: "sha1", at: new Date(at).toISOString(), runId: "pm", error: "retry: no answer" });
    const wake: number[] = [];
    assert.deepEqual(await premergeCandidates(w.db, { repo: "app", at, wake }), []);
    assert.equal(wake.length, 1);
    assert.deepEqual((await premergeCandidates(w.db, { repo: "app", at: wake[0]! })).map((c) => c.number), [1]);
  });

  test("a person's fix-up is pushed; the review fixes of a PR nobody started are not", async () => {
    const git = gitWorld(2);
    const w = await unapproved();
    await (await w.pr(1)).review(1, { verdict: "take-fix" });
    await (await w.pr(2, { head: git.head })).review(2, { verdict: "take-fix" });
    assert.deepEqual(await jobs(w, "fixup"), []);
    await say(w, "fix-up", 2);
    await w.db.run(w.db.k.updateTable("opus_reviews").set({ at: new Date().toISOString() }).where("number", "=", 2));
    assert.deepEqual((await actions(w, 2)).filter((a) => a.startsWith("fixup")), ["fixup:fix:review"]);
    assert.deepEqual(await jobs(w, "fixup"), ["fixup"]);
    await runFixup(w.db, { repo: "app", dryRun: false, by: "pipeline" }, quiet, git.deps(w));
    await endLint(w, await lastTask(w));
    assert.deepEqual(await jobs(w, "fixup"), ["fixup"]);
    const s = await runFixup(w.db, { repo: "app", dryRun: false, by: "pipeline" }, quiet, git.deps(w));
    assert.deepEqual(s.pushed, ["app#2"]);
    assert.deepEqual(git.pushes.map((p) => p.lease), [git.head]);
  });

  test("the CI fix of an approved PR is pushed; the red CI of a PR nobody started is left alone", async () => {
    const git = gitWorld(2, "fn a() {}\nfn main() { b(); }\n");
    const w = await unapproved();
    await (await w.pr(1, { ci: "failure" })).review(1);
    await (await w.pr(2, { head: git.head, ci: "failure" })).review(2);
    assert.deepEqual(await jobs(w, "cifix"), []);
    assert.deepEqual([(await w.prPlan(1)).wait, (await w.prPlan(1)).waitKind], ["push approval for the repo", "person"]);
    await say(w, "merge", 2);
    assert.deepEqual(await actions(w, 2), ["cifix:work"]);
    assert.deepEqual(await jobs(w, "cifix"), ["cifix"]);
    await runCifix(w.db, { repo: "app", dryRun: false, by: "pipeline" }, quiet, git.cifixDeps(w));
    await endLint(w, await lastTask(w));
    assert.deepEqual(await jobs(w, "cifix"), ["cifix"]);
    const s = await runCifix(w.db, { repo: "app", dryRun: false, by: "pipeline" }, quiet, git.cifixDeps(w));
    assert.deepEqual(s.pushed, ["app#2"]);
  });

  test("the base is merged into a conflicting PR that was queued without a review, and its pre-merge fix-up is worked", async () => {
    const git = gitWorld(2, undefined, true);
    const w = await unapproved();
    await w.pr(2, { head: git.head, mergeable: "CONFLICTING" });
    await w.db.run(w.db.k.updateTable("items").set({ base_ref: "main" }).where("number", "=", 2));
    await say(w, "merge", 2);
    assert.deepEqual((await actions(w, 2)).filter((a) => a !== "verify:plan"), ["conflict:merge"]);
    assert.deepEqual(await jobs(w, "fixup"), ["fixup"]);
    assert.equal((await selectFixups(w.db, "app")).conflictMerge.length, 1);

    await (await (await (await w.pr(3)).review(3)).verified(3)).premerge(3, "defect");
    await w.workflow(3, { by: "mira" });
    assert.deepEqual(await actions(w, 3), ["fixup:fix:premerge"]);
    assert.deepEqual((await selectFixups(w.db, "app")).fix.map((c) => [c.number, c.source]), [[3, "premerge"]]);
  });

  test("a person's implement command reaches its job; an issue nobody queued does not, and the implementation's PR is revised on the command", async () => {
    const w = await unapproved();
    await setFeature(w.db, "implement", true, OPERATOR, "app");
    await (await w.issue(4)).issue(5);
    assert.deepEqual(await jobs(w, "implement"), []);
    assert.match(await implementRefusal(w.db, "app", 5) ?? "", /not queued/);
    await say(w, "implement", 5);
    const found = await LANES.find((l) => l.name === "implement")!.detect(w.db, await planCtx(w.db));
    assert.deepEqual(found.map((c) => [c.step, c.params.number, c.params.bucket]), [["implement", 5, "plan"]]);
    await checkRequest(w.db, found[0]!.step, found[0]!.params);
    const grant = async (n: number) => await guardItem(w.db, { repo: "app", number: n }, { kind: "implement", bucket: "plan" }, "pipeline");
    assert.ok(!("refused" in await grant(5)));
    assert.match((await grant(4) as { refused: string }).refused, /issue is not queued/);
    const repoGrant = async (n: number) => await guardRepo(w.db, "app", "fix-issue", "pipeline", undefined, { members: [await implementMay(w.db, "app", n)] });
    assert.ok(!("refused" in await repoGrant(5)));
    assert.ok("refused" in await repoGrant(4));

    // Its PR came back with fixes: the session revises it.
    await (await w.pr(6, { author: "pipeline-bot" })).review(6, { verdict: "take-fix" });
    await w.db.run(w.db.k.insertInto("implementations").values({ repo: "app", number: 5, pr_number: 6, state: "pr-opened", text_hash: "h", attempt: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), queued_by: "mira" }));
    const f = (await w.plan()).prs.find((p) => p.facts.number === 6)!.facts;
    assert.equal(gates(f, { kind: "implement", bucket: "revise" }, "pipeline"), null);
    assert.match(gates({ ...f, implementation: { ...f.implementation!, queuedBy: null } }, { kind: "implement", bucket: "revise" }, "pipeline") ?? "", /not queued/);
  });

  test("a started PR nobody approved that conflicts or has red CI comes back with one recommendation", async () => {
    const w = await unapproved();
    await w.pr(1, { mergeable: "CONFLICTING" });
    await w.pr(2, { ci: "failure" });
    for (const n of [1, 2]) {
      await (await (await w.review(n)).verified(n)).workflow(n, { by: "mira", approved: false });
      assert.deepEqual([(await w.prPlan(n)).wait, (await w.prPlan(n)).waitKind], [MAINTAINER_ANSWER_WAIT, "person"]);
    }
    await advanceWorkflows(w.db);
    for (const n of [1, 2]) {
      const wf = await liveWorkflow(w.db, "app", n);
      assert.equal(wf?.state, "recommending");
      assert.ok(wf?.rec?.merges);
      assert.match(wf.rec.text, n === 1 ? /conflicts/ : /CI fails/, "it names what stopped the PR");
    }
    await writePlanCache(w.db, await w.plan());
    assert.deepEqual((await withConfig(w.db, () => computeLiveness(w.db))).items.filter((i) => i.verdict === "stuck"), []);
  });

  test("a repo whose fix-up selection fails leaves the lane to the others", async () => {
    const w = await unapproved();
    await w.db.run(w.db.k.insertInto("tracked_repos").values({ name: "bad", added_by: OPERATOR, added_at: T1, pipeline: 1 }));
    await (await w.pr(2)).review(2, { verdict: "take-fix" });
    await w.fixup(2, false);
    const ctx = await planCtx(w.db);
    assert.deepEqual(await actions(w, 2), ["fixup:fix:operator"]);
    const good = ctx.plans!.prs.find((p) => p.facts.number === 2)!;
    ctx.plans!.prs.push({ facts: { ...good.facts, repo: "bad", review: null, may: { ...good.facts.may!, repoPush: { by: OPERATOR, at: T1 } } }, plan: { ...good.plan, repo: "bad", actions: [{ kind: "fixup", head: good.plan.head, params: { bucket: "fix", source: "review" } }] } });
    ctx.tracked = ["bad", "app"];
    assert.deepEqual((await LANES.find((l) => l.name === "fixup")!.detect(w.db, ctx)).map((c) => c.params.repo), ["app"]);
    assert.match(ctx.notes!.fixup ?? "", /bad/);
  });
});
