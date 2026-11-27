// The issue of an infrastructure failure on a red default branch: one per red streak and check, and one across crashes and lost answers.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { mainFixDue, runMainFix, setMainFixApproval, type MainFixDeps } from "../src/mainfix/index.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const at = (min: number) => new Date(Date.parse("2026-01-01T00:00:00Z") + min * 60_000).toISOString();
const CHECK = "gate / deploy";

async function world() {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "mainfix-issue-")), "t.db"));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: at(0), pipeline: 1 }));
  await setMainFixApproval(db, "op", "app", true);
  const w = { created: 0, create: "ok" as "ok" | "lost" | "refused" | "limited", onGithub: [] as { number: number; url: string; title: string; body: string; at: string }[], listed: 0, unreadable: false, now: at(1) };
  const deps: MainFixDeps = {
    now: () => new Date(w.now),
    classify: async (_db, input) => input.checks.map((c) => ({ check: c.check, verdict: "infra" as const, reason: "a missing secret" })),
    gh: async (args) => {
      if (args[1]?.includes("check-runs")) return JSON.stringify({ check_runs: [{ name: CHECK, status: "completed", conclusion: "failure", details_url: "https://github.com/storytold/app/actions/runs/11/job/1" }] });
      if (args[0] === "run") return "deploy\tpush\tHTTP 403: missing secret\n";
      if (args.some((a) => a.includes("/issues?"))) { w.listed++; if (w.unreadable) throw new Error("no network"); return w.onGithub.map((i) => JSON.stringify(i)).join("\n"); }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    },
    exec: async (cmd, args, opts = {}) => {
      if (cmd !== "gh" || args[1] !== "create") return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
      if (w.create === "refused") return { code: 1, stdout: "", stderr: "HTTP 403: forbidden" };
      if (w.create === "limited") return { code: 1, stdout: "", stderr: "GraphQL: API rate limit already exceeded" };
      w.created++;
      const url = `https://github.com/storytold/app/issues/${40 + w.created}`;
      w.onGithub.push({ number: 40 + w.created, url, title: args[args.indexOf("--title") + 1]!, body: String(opts.input), at: new Date().toISOString() });
      return w.create === "lost" ? { code: 1, stdout: "", stderr: "timeout" } : { code: 0, stdout: `${url}\n`, stderr: "" };
    },
  };
  const head = async (sha: string, min: number, state = "red") => {
    await db.run(db.k.insertInto("main_ci").values({ repo: "app", head_sha: sha, branch: "main", state, failing: "[]", checks: "[]", committed_at: at(min), first_seen_at: at(min), state_changed_at: at(min), updated_at: at(min) }));
    w.now = at(min + 1);
  };
  const run = () => runMainFix(db, { repo: "app" }, () => {}, deps);
  const rows = async () => (await db.all(db.k.selectFrom("main_fixes").select(["head_sha", "state", "issue_number"]).orderBy("head_sha"))).map((r) => [r.head_sha, r.state, r.issue_number === null ? null : Number(r.issue_number)]);
  return { db, w, head, run, rows, due: () => mainFixDue(db, "app") };
}

test("later red heads of a streak share its issue, and a new streak opens another", async () => {
  const { db, w, head, run, rows } = await world();
  await head("a1", 0);
  await run();
  await head("a2", 10);
  // A rerun at the first red head turned it red again later: it is still the same streak.
  await db.run(db.k.updateTable("main_ci").set({ state_changed_at: at(9) }).where("head_sha", "=", "a1"));
  await run();
  assert.deepEqual([w.created, await rows()], [1, [["a1", "issue-opened", 41], ["a2", "issue-opened", 41]]]);
  await head("b0", 20, "green");
  await head("b1", 30);
  await run();
  assert.deepEqual([w.created, (await rows()).at(-1)], [2, ["b1", "issue-opened", 42]]);
});

test("a process that stopped around the create does not open a second issue", async () => {
  for (const audited of [true, false]) {
    const { db, w, head, run, rows, due } = await world();
    await head("a1", 0);
    await run();
    // The process ended before the row was saved; without the audit, also before the answer was recorded.
    await db.run(db.k.updateTable("main_fixes").set({ state: "issue-opening", issue_number: null }));
    if (!audited) await db.run(db.k.updateTable("audit").set({ details: JSON.stringify({ check: CHECK, title: w.onGithub[0]!.title, text: w.onGithub[0]!.body, state: "started" }) }).where("action", "=", "postmerge-file"));
    assert.equal(await due(), true);
    await run();
    assert.deepEqual([w.created, await rows(), w.listed > 0], [1, [["a1", "issue-opened", 41]], !audited]);
    assert.equal(await due(), false);
  }
});

test("a create whose answer was lost is looked up before it is made again, also at a later head, and never made while GitHub cannot be read", async () => {
  const { w, head, run, rows } = await world();
  await head("a1", 0);
  w.create = "lost";
  await assert.rejects(run(), /not known/);
  assert.deepEqual(await rows(), [["a1", "issue-opening", null]]);
  w.unreadable = true;
  await assert.rejects(run(), /not known/);
  await head("a2", 10);
  w.unreadable = false;
  w.create = "ok";
  await run();
  assert.deepEqual([w.created, await rows()], [1, [["a1", "issue-opened", 41], ["a2", "issue-opened", 41]]]);
});

test("an issue held back by a rate limit waits while the next head runs and is opened when that head is red", async () => {
  const { w, head, run, rows, due } = await world();
  await head("a1", 0);
  w.create = "limited";
  await assert.rejects(run(), /rate limit/);
  await head("a2", 10, "running");
  assert.equal(await due(), false);
  w.create = "ok";
  await run();
  assert.deepEqual(await rows(), [["a1", "issue-opening", null]]);
  await head("a3", 20);
  await run();
  assert.deepEqual([w.created, await rows()], [1, [["a1", "issue-opened", 41], ["a3", "issue-opened", 41]]]);
});

test("a row recorded before any create, and a create GitHub never made, open the issue; a refusal is tried again at the next red head", async () => {
  const { db, w, head, run, rows } = await world();
  await head("a1", 0);
  w.create = "refused";
  await run();
  assert.deepEqual(await rows(), [["a1", "issue-failed", null]]);
  w.create = "ok";
  await db.run(db.k.updateTable("main_fixes").set({ state: "issue-opening" }));
  await db.run(db.k.deleteFrom("audit").where("action", "=", "postmerge-file"));
  await run();
  assert.deepEqual([w.created, await rows()], [1, [["a1", "issue-opened", 41]]]);
  await db.run(db.k.updateTable("main_fixes").set({ state: "issue-opening", issue_number: null }));
  await db.run(db.k.updateTable("audit").set({ details: JSON.stringify({ check: CHECK, title: "t", text: "b", state: "failed", error: "timeout" }) }).where("action", "=", "postmerge-file"));
  w.onGithub = [];
  await run();
  assert.deepEqual([w.created, await rows()], [2, [["a1", "issue-opened", 42]]]);
});
