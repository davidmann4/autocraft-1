import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Querier } from "../src/mirror.ts";
import { setPushApproval } from "../src/fixup/approval.ts";
import type { Exec, ExecResult } from "../src/fixup/git.ts";
import { runFixup, type FixupDeps } from "../src/fixup/index.ts";
import { CancelledError, StoppedError } from "../src/agents/call.ts";
import { acting, appLane } from "./acting.ts";
import { reportingTaskRunner } from "./fake-runner.ts";
import { SCRATCH } from "./scratch.ts";
import { validating } from "./gql.ts";
import { insertWorkflow } from "../src/workflow/store.ts";
import { connectDb, type Db } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "fixup-pool-"));
process.env.AUTOCRAFT_DIFF_CACHE = join(dir, "diffs");
const T0 = "2026-01-01T00:00:00Z";
const FIXES = JSON.stringify([{ file: "src/lib.rs", change: "rename a to b" }]);
const head = (n: number) => String(n).repeat(40);

async function setup(prs: number): Promise<Db> {
  const db = await connectDb(join(mkdtempSync(join(dir, "db-")), "t.db"));
  await reportingTaskRunner(db);
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: T0, pipeline: 1 }));
  await setPushApproval(db, "op", "app", true);
  for (let n = 1; n <= prs; n++) {
    await db.run(db.k.insertInto("items").values({ repo: "app", number: n, kind: "pr", state: "OPEN", title: "Fix a thing", author: "someone", additions: 5, deletions: 0, head_oid: head(n), head_ref: "fix", head_repo: "contrib/app", base_ref: "main",
      maintainer_can_modify: 1, mergeable: "MERGEABLE", created_at: T0, updated_at: T0 }));
    await db.run(db.k.insertInto("opus_reviews").values({ repo: "app", number: n, head_oid: head(n), run_id: "rv", at: T0, model: "m", verdict: "take-fix", reason: "nearly right", fixes: FIXES, sure: 1, mode: "full" }));
    await insertWorkflow(db, { repo: "app", number: n, kind: "pr", entry: "fixup", state: "running", startedBy: "op", startedAt: T0, startedVia: "dashboard" });
    await acting(db, ["op"]);
  }
  return db;
}

/** Runs the job; the fake model call returns only once `need` calls wait at the same time. */
async function run(limit: number | undefined, need: number, o: { prs?: number; moved?: number; ask?: () => Promise<null> } = {}) {
  const db = await setup(o.prs ?? 3);
  const querier: Querier = validating({
    spent: 0, remaining: 5000,
    async query(_q: string, v: object) {
      const n = Number((v as { n?: number }).n);
      return { repository: { pullRequest: { id: `PR${n}`, number: n, state: "OPEN", isDraft: false, headRefOid: n === o.moved ? head(9) : head(n), headRefName: "fix", maintainerCanModify: true, mergeable: "MERGEABLE", headRepository: { nameWithOwner: "contrib/app" }, assignees: { nodes: [] } } } };
    },
  });
  const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });
  const exec: Exec = async (cmd, args) => {
    if (cmd === "gh") return ok(JSON.stringify({ login: "pipeline-bot", id: 42, node_id: "U42" }));
    if (args.includes("--git-dir")) return ok(".\n");
    const ref = args.find((a) => /^refs\/fixup\/pr-\d+$/.test(a));
    if (args.includes("rev-parse") && ref) return ok(head(Number(ref.split("-").pop())) + "\n");
    if (args.includes("ls-tree")) return ok("100644 blob abc\tsrc/lib.rs\n");
    if (args.includes("cat-file")) return ok("fn a() {}\n");
    return ok("");
  };
  let waiting = 0, peak = 0, asked = 0;
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const failures = async () => (await db.get(db.k.selectFrom("fixups").select((eb) => eb.fn.countAll<number>().as("n")).where("state", "=", "failed")))!.n;
  const deps = {
    querier, lane: appLane(querier), exec, now: () => new Date(T0), root: join(dir, "cache"),
    fetchDiff: async () => ({ ok: true, text: "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-x\n+y\n" }),
    ask: o.ask ?? (async () => { asked++; peak = Math.max(peak, ++waiting); if (waiting >= need) open(); await Promise.race([gate, new Promise((_, no) => setTimeout(() => no(new Error("model calls did not overlap")), 5000))]); waiting--; return null; }),
  } as unknown as FixupDeps;
  let handled = 0;
  let err: unknown = null;
  try { await runFixup(db, { repo: "app", ...(limit === undefined ? {} : { limit }), dryRun: false, onHandled: (n) => { handled = n; } }, () => {}, deps); } catch (e) { err = e; }
  return { asked, peak, handled, err, failures: await failures() };
}

test("a job's model calls run at the same time and its limit counts exactly", async () => {
  const all = await run(undefined, 3);
  assert.deepEqual([all.asked, all.peak, all.handled], [3, 3, 3]);
  const two = await run(2, 2);
  assert.deepEqual([two.asked, two.peak, two.handled], [2, 2, 2]);
});

test("a skipped item gives its unit back and a waiting item takes it", async () => {
  const r = await run(1, 1, { moved: 1 });
  assert.deepEqual([r.asked, r.handled], [1, 1]);
});

test("at most max items of a pool run at once", async () => {
  const r = await run(undefined, 3, { prs: 5 });
  assert.deepEqual([r.asked, r.peak], [5, 3]);
});

test("a cancel during a waiting call records no failure", async () => {
  const r = await run(undefined, 1, { prs: 1, ask: async () => { throw new CancelledError("cancelled while waiting for a Claude account"); } });
  assert.ok(r.err instanceof CancelledError);
  assert.equal(r.failures, 0);
});

test("a stop during a waiting call records no failure", async () => {
  const r = await run(undefined, 1, { prs: 1, ask: async () => { throw new StoppedError("the pipeline was switched off"); } });
  assert.ok(r.err instanceof StoppedError);
  assert.equal(r.failures, 0);
});
