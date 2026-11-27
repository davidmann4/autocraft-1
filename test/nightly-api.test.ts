import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { grid, openIssue, select, series } from "../src/dash/api/nightly.ts";
import { defaultDeps } from "../src/nightly/index.ts";
import { setFeature } from "../src/build/features.ts";
import { TOPICS } from "../src/db/live.ts";
import { INPUT_TOPICS } from "../src/runner/autopilot.ts";
import type { Req } from "../src/dash/types.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });

const req = (json: unknown, params: Record<string, string> = {}): Req =>
  ({ params, query: new URLSearchParams(), json, user: { login: "op", role: "operator", canRead: async () => true } }) as unknown as Req;

test("selection validates names, hidden repos are 404, the grid shows a bench delta, and the topic is not planner input", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "nq-")), "t.db"));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: "2026-01-01T00:00:00Z", pipeline: 1 }));
  await setFeature(db, "nightly", true, "op", "app");

  await assert.rejects(select(db, req({ repo: "app", check: "miri", enabled: true, crates: ["ok", "a b; rm"] })), /crates must be/);
  await assert.rejects(select(db, req({ repo: "app", check: "nope", enabled: true })), /check must be/);
  await assert.rejects(select(db, req({ repo: "other", check: "miri", enabled: true })), /no such repo/);
  const g = await select(db, req({ repo: "app", check: "miri", enabled: true, crates: ["core", "core", "ffi"] }));
  assert.deepEqual(g.repos[0]!.checks.find((c) => c.id === "miri"), { id: "miri", label: "Miri", enabled: true, experimental: false, needs: null, takes: "crates", crates: ["core", "ffi"], targets: [], cells: [], issue: null, canOpenIssue: false });

  for (let i = 0; i < 8; i++) await db.run(db.k.insertInto("nightly_bench").values({ repo: "app", bench: "parse", sha: `s${i}`, at: `2026-01-0${i + 1}T00:00:00Z`, value: i < 7 ? 100 : 120, unit: "ns/iter" }));
  assert.equal((await grid(db, req({}))).repos[0]!.benches[0]!.deltaPct, 20);
  assert.equal((await series(db, req({}, { repo: "app", bench: "parse" }))).points.length, 8);

  assert.ok(TOPICS.includes("nightly") && !INPUT_TOPICS.includes("nightly"));
});

test("a failing streak offers its issue to those who may run the repo, and the press shows its number", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "nq-")), "t.db"));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: "2026-01-01T00:00:00Z", pipeline: 1 }));
  await setFeature(db, "nightly", true, "op", "app");
  for (const n of [1, 2]) {
    await db.run(db.k.insertInto("nightly_runs").values({ id: n, repo: "app", sha: "s", started_at: `2026-01-0${n}T00:00:00Z`, state: "done" }));
    await db.run(db.k.insertInto("nightly_results").values({ run_id: n, check_id: "audit", state: "fail" }));
  }
  const as = (role: string, writes: boolean, json: unknown = { repo: "app", check: "audit" }): Req =>
    ({ ...req(json), user: { login: "mia", role, canRead: async () => true, canWrite: async () => writes } }) as unknown as Req;
  const check = (g: Awaited<ReturnType<typeof grid>>) => { const c = g.repos[0]!.checks.find((x) => x.id === "audit")!; return [c.issue, c.canOpenIssue]; };
  assert.deepEqual(check(await grid(db, as("maintainer", false))), [null, false]);
  assert.deepEqual(check(await grid(db, as("maintainer", true))), [null, true]);
  const by: string[] = [];
  const deps = { ...defaultDeps(), openIssue: async (_db: unknown, o: { by: string }) => { by.push(o.by); return { number: 5, url: "https://github.com/x/app/issues/5" }; } };
  for (const r of [as("viewer", true), as("maintainer", false)]) await assert.rejects(openIssue(db, r, deps), /write access/);
  await assert.rejects(openIssue(db, as("maintainer", true, { repo: "app", check: "asan" }), deps), /experimental/);
  assert.deepEqual(check(await openIssue(db, as("maintainer", true), deps)), [5, false]);
  await assert.rejects(openIssue(db, as("operator", true), deps), /#5 is already open/);
  assert.deepEqual(by, ["mia"]);
});
