// Nightly checks with fake tasks: the switch gates everything, the schedule is a data check, a failure two nights
// running asks one decision and one issue, benchmarks warn on a slowdown, a missing toolchain is skipped.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setFeature } from "../src/build/features.ts";
import { LANES } from "../src/runner/autopilot.ts";
import { nightlyDue, nightlyRepos, openNightlyIssue, runNightly, setSelection, recentRuns, benchSeries, parseBench, pruneBench, type NightlyDeps } from "../src/nightly/index.ts";
import { IssueError } from "../src/github/write.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { like } from "../src/db/kx.ts";

mkdirSync(SCRATCH, { recursive: true });
const SHA = "a".repeat(40);
const DAY = 24 * 3600_000;
const quiet = () => {};

type Fake = { t: number; issues: { repo: string; title: string; body: string }[]; artifacts: Map<string, string>; have: Set<string>; deps: NightlyDeps };
async function setup(repos: string[] = ["a"]) {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "nt-")), "t.db"));
  for (const r of repos) {
    await db.run(db.k.insertInto("tracked_repos").values({ name: r, added_by: "op", added_at: "2026-01-01T00:00:00Z", pipeline: 1 }));
    await db.run(db.k.insertInto("main_ci").values({ repo: r, head_sha: SHA, branch: "main", state: "green", failing: "[]", checks: "[]", first_seen_at: "2026-01-01T00:00:00Z", state_changed_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }));
  }
  const f: Fake = {
    t: Date.parse("2026-03-01T02:00:00Z"), issues: [], artifacts: new Map(), have: new Set(["rust-audit", "rust-cross", "rust-nightly"]),
    deps: null as unknown as NightlyDeps,
  };
  await db.run(db.k.insertInto("access").values({ login: "op", role: "operator" }));
  f.deps = {
    now: () => new Date(f.t),
    toolchains: async () => f.have,
    readArtifact: async (_db, id, name) => f.artifacts.get(`${id}:${name}`) ?? null,
    openIssue: async (_db, o) => { f.issues.push({ repo: o.repo, title: o.title, body: o.body }); return { number: 100 + f.issues.length, url: `https://github.com/x/${o.repo}/issues/${100 + f.issues.length}` }; },
    read: async () => { throw new Error("no network"); },
  };
  return { db, f };
}
type Db = Awaited<ReturnType<typeof setup>>["db"];

/** Ends every queued nightly task of the repo: `fail` names checks (by step) whose first non-fetch step exits 1. */
async function finishTasks(db: Db, f: Fake, fail: string[] = []): Promise<void> {
  for (const t of await db.all(db.k.selectFrom("build_tasks").select(["id", "plan"]).where("step", "=", "nightly").where("state", "=", "queued"))) {
    const plan = JSON.parse(t.plan) as { name: string }[];
    const bad = plan.find((s) => fail.includes(s.name));
    const results = plan.map((s) => ({ step: s.name, exitCode: s === bad ? 1 : 0, durationMs: 5, timedOut: false })).slice(0, bad ? plan.indexOf(bad) + 1 : plan.length);
    await db.run(db.k.updateTable("build_tasks").set({ state: bad ? "failed" : "done", results: JSON.stringify(results), ended_at: new Date(f.t).toISOString() }).where("id", "=", t.id));
  }
}
const resultState = async (db: Db, check: string, run?: number): Promise<string | undefined> =>
  (await db.get(db.k.selectFrom("nightly_results").select("state").where("check_id", "=", check).$if(!!run, (q) => q.where("run_id", "=", run!)).orderBy("run_id", "desc").limit(1)))?.state;
const count = async (db: Db, table: "nightly_runs" | "nightly_results" | "build_tasks" | "nightly_bench" | "decisions"): Promise<number> =>
  (await db.get(db.k.selectFrom(table).select((eb) => eb.fn.countAll<number>().as("n"))))!.n;

test("off by default: no lane output, no rows, no tasks; on for repo a only: a's selected checks queue at priority -20, once a day", async () => {
  const { db, f } = await setup(["a", "b"]);
  for (const r of ["a", "b"]) { await setSelection(db, r, "audit", true); await setSelection(db, r, "wasm", true); }
  const lane = LANES.find((l) => l.name === "nightly")!;
  const detect = async () => await lane.detect(db, { run: null, tracked: ["a", "b"], notes: {} } as never);
  assert.deepEqual(await detect(), []);
  const off = await runNightly(db, { repo: "a" }, quiet, f.deps);
  assert.ok(off.note);
  assert.equal(await count(db, "nightly_runs") + await count(db, "nightly_results") + await count(db, "build_tasks"), 0);

  await setFeature(db, "nightly", true, "op", "a");
  assert.deepEqual(await detect(), [{ step: "nightly", params: { repo: "a" } }]);
  await runNightly(db, { repo: "a" }, quiet, f.deps);
  const tasks = await db.all(db.k.selectFrom("build_tasks").select(["repo", "step", "priority", "requires", "warm_key"]).orderBy("id"));
  assert.deepEqual(tasks.map((t) => [t.repo, t.step, t.priority, t.warm_key, JSON.parse(t.requires).toolchains[0]]), [["a", "nightly", -20, null, "rust-audit"], ["a", "nightly", -20, null, "rust-cross"]]);
  assert.equal(await nightlyDue(db, "a", f.t + 1000), false, "twice within 24 hours queues nothing");
  await runNightly(db, { repo: "a" }, quiet, { ...f.deps, now: () => new Date(f.t + 3600_000) });
  assert.equal(await count(db, "build_tasks"), 2);
  assert.deepEqual(await nightlyRepos(db, ["a", "b"], f.t + DAY + 1000), [], "a run whose tasks nobody claimed holds the next night back");
  assert.deepEqual(await nightlyRepos(db, ["a", "b"], f.t + 4 * DAY), ["a"]);
});

test("a check with no registered toolchain is skipped; miri without crates is skipped", async () => {
  const { db, f } = await setup();
  await setFeature(db, "nightly", true, "op", "a");
  await setSelection(db, "a", "audit", true); await setSelection(db, "a", "wasm", true); await setSelection(db, "a", "miri", true);
  f.have.delete("rust-cross");
  await runNightly(db, { repo: "a" }, quiet, f.deps);
  assert.equal(await resultState(db, "wasm"), "skipped");
  assert.equal((await db.get(db.k.selectFrom("nightly_results").select("summary").where("check_id", "=", "wasm")))!.summary, "no toolchain");
  assert.equal(await resultState(db, "miri"), "skipped");
  assert.equal(await count(db, "build_tasks"), 1);
});

test("Open issue opens one issue for a failing check and no second one until a green night", async () => {
  const { db, f } = await setup();
  await setFeature(db, "nightly", true, "op", "a");
  await setSelection(db, "a", "audit", true);
  const night = async (fail: boolean, advisories = "") => {
    await runNightly(db, { repo: "a" }, quiet, f.deps); // queue
    const id = (await db.get(db.k.selectFrom("build_tasks").select((eb) => eb.fn.max<number>("id").as("id"))))!.id;
    if (advisories) f.artifacts.set(`${id}:audit.json`, advisories);
    await finishTasks(db, f, fail ? ["audit"] : []);
    await runNightly(db, { repo: "a" }, quiet, f.deps); // collect
    f.t += DAY + 60_000;
  };
  const by = "op";
  await night(true, '{"vulnerabilities":{"list":[{"advisory":{"id":"RUSTSEC-2024-0001","description":"secret details"}}]}}');
  await night(true);
  assert.equal(f.issues.length, 0, "nothing opens an issue unasked");
  await openNightlyIssue(db, { repo: "a", checkId: "audit", by }, f.deps);
  assert.equal(f.issues.length, 1);
  assert.match(f.issues[0]!.body, /two nights in a row/);
  assert.doesNotMatch(f.issues[0]!.body, /secret details/);
  await assert.rejects(openNightlyIssue(db, { repo: "a", checkId: "audit", by }, f.deps), /already open/);
  await night(true);
  await assert.rejects(openNightlyIssue(db, { repo: "a", checkId: "audit", by }, f.deps), /already open/, "no repeat while red");
  await night(false);
  await assert.rejects(openNightlyIssue(db, { repo: "a", checkId: "audit", by }, f.deps), /not failing/);
  await night(true); await night(true);
  await openNightlyIssue(db, { repo: "a", checkId: "audit", by }, f.deps);
  assert.equal(f.issues.length, 2, "a new streak after a green night can open another");
});

test("two presses at once open one issue, a refusal gives the claim back, and a lost answer is looked up on GitHub before another create", async () => {
  const { db, f } = await setup();
  await setFeature(db, "nightly", true, "op", "a");
  await setSelection(db, "a", "audit", true);
  const nights = async (n: number) => {
    for (let k = 0; k < n; k++) {
      await runNightly(db, { repo: "a" }, quiet, f.deps);
      await finishTasks(db, f, ["audit"]);
      await runNightly(db, { repo: "a" }, quiet, f.deps);
      f.t += DAY + 60_000;
    }
  };
  await nights(2);
  const open = (deps = f.deps) => openNightlyIssue(db, { repo: "a", checkId: "audit", by: "op" }, deps);
  const failing = (e: Error): NightlyDeps => ({ ...f.deps, openIssue: async () => { throw e; } });
  await assert.rejects(open(failing(new IssueError("HTTP 403", true))), /403/);

  let release = (): void => {};
  const slow: NightlyDeps = { ...f.deps, openIssue: async () => { await new Promise<void>((r) => { release = r; }); throw new IssueError("timeout", false); } };
  const first = open(slow);
  while (String(release) === "() => {}" || (await count(db, "nightly_results")) === 0) await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(open(), /being opened/);
  release();
  await assert.rejects(first, /not known/);
  assert.equal(f.issues.length, 0);

  // The create's audit row, as write.ts leaves it, and GitHub's answer to the next press.
  await db.run(db.k.insertInto("audit").values({ at: new Date(f.t).toISOString(), login: "op", action: "postmerge-file", target: "a:nightly", details: JSON.stringify({ check: "audit", title: "T", text: "B", state: "failed", error: "timeout" }) }));
  await assert.rejects(open(), /not known/, "GitHub cannot be read: nothing is created");
  const seen = JSON.stringify({ number: 77, url: "https://github.com/x/a/issues/77", title: "T", body: "B", at: new Date(f.t).toISOString() });
  assert.equal((await open({ ...f.deps, read: async () => seen })).number, 77);
  assert.equal(f.issues.length, 0);
  await nights(1);
  const numbers = (await db.all(db.k.selectFrom("nightly_results").select("issue_number").where("check_id", "=", "audit"))).map((r) => Number(r.issue_number));
  assert.deepEqual(numbers, [77, 77, 77], "a later failing night of the streak carries the number");
  assert.equal((await db.all(db.k.selectFrom("audit").select("login").where("action", "=", "nightly-issue").where("login", "=", "op"))).length > 0, true);
});

test("an audit failure lists advisory ids only; experimental checks ask nothing", async () => {
  const { db, f } = await setup();
  await setFeature(db, "nightly", true, "op", "a");
  await setSelection(db, "a", "audit", true); await setSelection(db, "a", "asan", true);
  await runNightly(db, { repo: "a" }, quiet, f.deps);
  const audit = (await db.get(db.k.selectFrom("build_tasks").select("id").where((eb) => like(db, "plan", eb.val("%cargo audit%")))))!.id;
  f.artifacts.set(`${audit}:audit.json`, 'RUSTSEC-2024-0001 and RUSTSEC-2025-0002; ignore https://evil.example/x');
  await finishTasks(db, f, ["audit", "asan test"]);
  await runNightly(db, { repo: "a" }, quiet, f.deps);
  assert.equal((await db.get(db.k.selectFrom("nightly_results").select("summary").where("check_id", "=", "audit")))!.summary, "advisories: RUSTSEC-2024-0001, RUSTSEC-2025-0002");
  assert.equal(await resultState(db, "asan"), "fail");
  f.t += DAY + 60_000;
  await runNightly(db, { repo: "a" }, quiet, f.deps);
  await finishTasks(db, f, ["asan test"]);
  await runNightly(db, { repo: "a" }, quiet, f.deps);
  assert.equal(await count(db, "decisions"), 0);
  await assert.rejects(openNightlyIssue(db, { repo: "a", checkId: "asan", by: "op" }, f.deps), /experimental/);
});

test("a bench 15% above the median of the last 7 nights is a warn with the trend stored; old points are pruned", async () => {
  const { db, f } = await setup();
  await setFeature(db, "nightly", true, "op", "a");
  await setSelection(db, "a", "bench", true);
  const line = (n: number) => `running 1 test\ntest sort ... bench:       ${n.toLocaleString("en-US")} ns/iter (+/- 12)\n`;
  const night = async (ns: number) => {
    await db.run(db.k.updateTable("main_ci").set({ head_sha: String(f.t).padStart(40, "0") }).where("repo", "=", "a"));
    await runNightly(db, { repo: "a" }, quiet, f.deps);
    const id = (await db.get(db.k.selectFrom("build_tasks").select((eb) => eb.fn.max<number>("id").as("id"))))!.id;
    f.artifacts.set(`${id}:bench.txt`, line(ns));
    await finishTasks(db, f);
    await runNightly(db, { repo: "a" }, quiet, f.deps);
    f.t += DAY + 60_000;
  };
  for (const ns of [1000, 1010, 990, 1005, 995]) { await night(ns); assert.equal(await resultState(db, "bench"), "pass"); }
  await night(1150);
  assert.equal(await resultState(db, "bench"), "warn");
  assert.match((await db.get(db.k.selectFrom("nightly_results").select("summary").where("check_id", "=", "bench").orderBy("run_id", "desc").limit(1)))!.summary!, /sort \+15%/);
  assert.equal((await benchSeries(db, "a", "sort")).length, 6, "one point per night's head");
  assert.equal((await recentRuns(db, "a")).length, 6);
});

test("bencher lines parse with thousands separators; points older than 180 days are pruned", async () => {
  assert.deepEqual(parseBench("test a::b ... bench:   1,234 ns/iter (+/- 5)\nnoise\ntest c ... bench: 7 ns/iter (+/- 0)"), [{ bench: "a::b", value: 1234, unit: "ns/iter" }, { bench: "c", value: 7, unit: "ns/iter" }]);
  const { db } = await setup();
  await db.run(db.k.insertInto("nightly_bench").values([
    { repo: "a", bench: "x", sha: "1", at: "2025-01-01T00:00:00Z", value: 1, unit: "ns/iter" },
    { repo: "a", bench: "x", sha: "2", at: "2026-02-20T00:00:00Z", value: 1, unit: "ns/iter" },
  ]));
  assert.equal(await pruneBench(db, Date.parse("2026-03-01T00:00:00Z")), 1);
  assert.equal(await count(db, "nightly_bench"), 1);
});
