// An ask comment that never reached GitHub (the GitHub App's installation token could not be minted, so no request went
// out) is asked again after a backoff, and not before; a comment whose request went out stays final.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { mock, test } from "node:test";
import { setCommentApproval } from "../src/act/approval.ts";
import { CLI_BY } from "../src/core/gates.ts";
import { loadPrFacts } from "../src/core/facts.ts";
import { decidePr } from "../src/core/decide.ts";
import { askConflict, type ConflictRun } from "../src/fixup/conflict.ts";
import type { ConflictCandidate } from "../src/fixup/conflict-state.ts";
import type { FixupDeps, FixupSummary } from "../src/fixup/index.ts";
import { setGithubIdentity } from "../src/github/identity.ts";
import { acting } from "./acting.ts";
import { SCRATCH } from "./scratch.ts";
import type { GuardedItem, GuardedRepo, Guarded } from "../src/core/guard.ts";
import { commentOn, createIssue, ghComment, postReview, type Writer } from "../src/github/write.ts";
import { insertWorkflow } from "../src/workflow/store.ts";
import { connectDb } from "./helpers/raw-db.ts";
import * as kx from "../src/db/kx.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "unsent-comment-"));
const T0 = Date.parse("2026-11-10T12:00:00Z");
const HEAD = "a".repeat(40);
const MIN = 60_000;

test("a conflict ask whose token mint failed is asked again after the backoff, not before; one whose request went out is final; a quiet pull request is not asked", async () => {
  mock.timers.enable({ apis: ["Date"], now: T0 });
  try {
    const db = await connectDb(join(dir, "t.db"));
    const iso = (ms: number) => new Date(ms).toISOString();
    await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: iso(T0 - 60 * MIN), pipeline: 1 }));
    await setCommentApproval(db, "op", "app", true);
    await setGithubIdentity(db, "op", "app");
    // A contributor's PR from a fork we can't push to, taken by the review, that conflicts with main.
    await db.run(db.k.insertInto("items").values({ repo: "app", number: 1, kind: "pr", state: "OPEN", title: "Fix a thing", author: "someone", additions: 5, deletions: 0, head_oid: HEAD, head_ref: "fix", head_repo: "contrib/app", base_ref: "main", maintainer_can_modify: 0, mergeable: "CONFLICTING", created_at: iso(T0 - 60 * MIN), updated_at: iso(T0 - 60 * MIN) }));
    await db.run(db.k.insertInto("opus_reviews").values({ repo: "app", number: 1, head_oid: HEAD, run_id: "rv", at: iso(T0 - 30 * MIN), model: "m", verdict: "take", reason: "right", fixes: "[]", sure: 1, mode: "full" }));
    await insertWorkflow(db, { repo: "app", number: 1, kind: "pr", entry: "fixup", state: "running", startedBy: "op", startedAt: iso(T0 - 40 * MIN), startedVia: "dashboard" });
    await acting(db, ["op"]);

    await db.run(db.k.insertInto("verifications").values({ repo: "app", number: 1, head_sha: HEAD, kind: "ci-enough", reason: "upstream CI", state: "ci-enough", created_at: iso(T0 - 20 * MIN) }));
    const plan = async () => decidePr((await loadPrFacts(db, { now: Date.now() })).find((f) => f.number === 1)!);
    const plannedAsk = async () => (await plan()).actions.some((a) => a.kind === "conflict" && a.params?.bucket === "ask");
    const rows = async () => (await db.all(db.k.selectFrom("conflict_merges").select("state").where("repo", "=", "app").where("number", "=", 1).orderBy(kx.rowid("conflict_merges")))).map((r) => r.state);

    let mintFails = true;
    let sent = 0;
    const exec = async () => { sent++; return { code: 1, stdout: "", stderr: "HTTP 502: Bad Gateway" }; };
    const querier = { spent: 0, remaining: 5000, async query() {
      return { repository: { pullRequest: { id: "PR1", number: 1, state: "OPEN", isDraft: false, headRefOid: HEAD, headRefName: "fix", baseRefName: "main", maintainerCanModify: false, mergeable: "CONFLICTING", headRepository: { nameWithOwner: "contrib/app" }, assignees: { nodes: [] } } } };
    } };
    const log: string[] = [];
    const x = {
      repo: "app", runId: "run", log: (l: string) => log.push(l), d: { querier, exec } as unknown as FixupDeps,
      gw: { db, login: "pipeline", mint: async () => { if (mintFails) throw new Error("POST /app/installations/1/access_tokens HTTP 500"); return "ghs_token"; } },
      at: () => new Date().toISOString(), summary: { asked: [], failed: [], held: [] } as unknown as FixupSummary,
      prQuery: "query", scrub: (s: string) => s, handled: { n: 0 }, by: CLI_BY,
    } as unknown as ConflictRun;
    const c = { repo: "app", number: 1, head: HEAD, base: "main", title: "Fix a thing", reason: "right", attempt: 1, pushable: false } as ConflictCandidate;

    await db.run(db.k.insertInto("security_scans").values({ id: 1, repo: "app", state: "done", started_by: "op", started_at: iso(T0) }));
    await db.run(db.k.insertInto("security_findings").values({ repo: "app", number: 50, scan_id: 1, area: "a", title: "t", severity: "high", urgent: 0, state: "landing", refs: "[]", reach: "r", impact: "i", fingerprint: "fp", created_at: iso(T0), updated_at: iso(T0), fix_pr: 1 }));
    assert.deepEqual([await plannedAsk(), (await plan()).waitCode], [false, "conflict-person"]);
    await askConflict(db, x, c);
    assert.deepEqual(await rows(), []);
    assert.ok(log.some((l) => l.includes("quiet")), log.join("\n"));
    await db.run(db.k.updateTable("security_findings").set({ state: "dismissed" }));

    assert.equal(await plannedAsk(), true);
    await askConflict(db, x, c);
    assert.deepEqual(await rows(), ["comment-unsent"]);
    assert.equal(sent, 0, "no request went out");

    // Before the backoff ends the plan has no ask, and the step's guard refuses one.
    mock.timers.setTime(T0 + 9 * MIN);
    assert.equal(await plannedAsk(), false);
    assert.deepEqual([(await plan()).wait, (await plan()).waitKind], ["the comment asking the contributor to resolve the conflict again after 12:10: the last one did not reach GitHub", "system"]);
    await askConflict(db, x, c);
    assert.deepEqual(await rows(), ["comment-unsent"]);

    // After it the ask is due again. This time the request goes out and fails: GitHub may have posted it, so it is final.
    mock.timers.setTime(T0 + 11 * MIN);
    assert.equal(await plannedAsk(), true);
    mintFails = false;
    await askConflict(db, x, c);
    assert.equal(sent, 1);
    assert.deepEqual(await rows(), ["comment-unsent", "comment-failed"]);
    mock.timers.setTime(T0 + 24 * 60 * MIN);
    assert.equal(await plannedAsk(), false);
  } finally {
    mock.timers.reset();
  }
});

test("a comment, issue or review that never went out is made by the next try with no look on GitHub; one that went out is looked for", async () => {
  const db = await connectDb(join(dir, "siblings.db"));
  await setGithubIdentity(db, "op", "app");
  const g = { scope: "item", action: { kind: "act" }, repo: "app", number: 3, as: "app" } as unknown as GuardedItem;
  const gr = { scope: "repo", repo: "app", as: "app" } as unknown as GuardedRepo;
  const gp = { scope: "pr", action: { kind: "post-review" }, repo: "app", number: 3, head: HEAD, as: "app" } as unknown as Guarded<"post-review">;
  const note = { by: "fixed" } as const, item = { repo: "app", number: 3, id: "I3" };
  let mode: "no-token" | "lost" = "no-token", made = 0, looks = 0;
  const exec = async (_cmd: string, args: string[]) => {
    if (args[0] === "api") { looks++; return { code: 0, stdout: "", stderr: "" }; }
    made++;
    return { code: 1, stdout: "", stderr: "timeout" };
  };
  const q = { spent: 0, remaining: 5000, async query(text: string) {
    if (!text.startsWith("mutation")) { looks++; return { node: null }; }
    made++;
    throw new Error("timeout");
  } };
  const w: Writer = { db, login: "act", mint: async () => { if (mode === "no-token") throw new Error("HTTP 500"); return "ghs_token"; }, appClient: () => q };
  const writes = [
    () => ghComment(w, g, exec, "act-comment", { repo: "app", number: 3, pr: false }, note, "by gh"),
    () => commentOn(w, g, q, "act-comment", item, note, "by GraphQL"),
    () => createIssue(w, gr, exec, { repo: "app", target: "app#3", title: "t", body: "b" }, note),
    () => postReview(w, q, gp, "I3", note, "review"),
  ];
  const all = async () => { made = looks = 0; for (const f of writes) await f().catch(() => {}); return [made, looks]; };
  assert.deepEqual(await all(), [0, 0], "no token: nothing goes out");
  mode = "lost";
  assert.deepEqual(await all(), [4, 0], "the tries before are known not to have gone out");
  assert.deepEqual(await all(), [4, 4], "these may have");
});
