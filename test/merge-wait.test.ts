// A merge made as its approver waits for their sign-in: it is recorded as the workflow's merge action, no merge is planned or tried
// again until they sign in, and the item's state line names them.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { addOwnCommits, setStepApproval } from "../src/data/control/index.ts";
import { recordSteps, startAttempt } from "../src/data/implement/index.ts";
import { loadActions } from "../src/data/workflow/index.ts";
import { planned } from "../src/core/select.ts";
import { retryWaiting, type LaneDeps } from "../src/github/user-lane.ts";
import { runMerge } from "../src/merge/index.ts";
import { advancePreapprovals } from "../src/preapproval/index.ts";
import { advanceWorkflows } from "../src/workflow/advance.ts";
import { runCommand, type Actor } from "../src/workflow/apply.ts";
import { parse } from "../src/workflow/parse.ts";
import { liveWorkflow } from "../src/workflow/store.ts";
import { legWait } from "../src/workflow/waits.ts";
import { world, type World } from "./world-db.ts";

let current: World | undefined;
afterEach(() => current?.close());
const quiet = () => {};
const APPROVER = "mira";
const actor: Actor = { login: APPROVER, canWrite: async () => true };

/** PR 1 started with "review and merge"; or issue 7 started with "implement and merge", whose implementation opened PR 1. Returns the started item. */
async function startWork(w: World, kind: "pr" | "issue"): Promise<number> {
  const { db } = w;
  const run = async (text: string, number: number) => {
    const r = await runCommand(db, actor, "dashboard", { parsed: parse(text), items: [{ repo: "app", number }] });
    assert.equal(r.items[0]!.outcome, "run", r.lines.join("\n"));
  };
  if (kind === "pr") {
    await w.pr(1, { label: "feature" });
    await run("review and merge", 1);
    return 1;
  }
  await w.issue(7);
  await run("implement and merge", 7);
  const im = (await startAttempt(db, { repo: "app", number: 7, queuedBy: APPROVER, textHash: "h" }))!;
  await w.pr(1, { label: "feature", author: "craft-bot" });
  await addOwnCommits(db, [{ repo: "app", sha: "sha1", action: "implement-push" }]);
  await recordSteps(db, [{ id: im.id, to: "pr-opened", patch: { branch: "fix-1", prNumber: 1, prUrl: "https://example.invalid/1" } }]);
  await advanceWorkflows(db);
  return 7;
}

for (const kind of ["pr", "issue"] as const) test(`an approved merge of ${kind === "pr" ? "a PR" : "an issue's implementation PR"} whose approver has no sign-in waits, is neither planned nor tried again, and merges once they signed in`, async () => {
  const w = current = await (await world()).repo();
  const db = w.db;
  await setStepApproval(db, [{ repo: "app", step: "merge", on: true }], APPROVER);
  await db.run(db.k.insertInto("main.settings").values({ key: "github_identity", value: "app" }).onConflict((oc) => oc.column("key").doUpdateSet({ value: "app" })));
  await db.run(db.k.insertInto("main.access").values({ login: APPROVER, role: "operator" }));
  await db.run(db.k.insertInto("main.repo_permissions").values({ login: APPROVER, repo: "app", permission: "write", checked_at: new Date().toISOString() }));
  const item = await startWork(w, kind);
  await db.run(db.k.insertInto("main.opus_reviews").values({ repo: "app", number: 1, head_oid: "sha1", run_id: "rv", at: new Date().toISOString(), model: "m", mode: "full", verdict: "take", sure: 1, reason: "r" }));
  await w.verified(1);
  for (let i = 0; i < 2; i++) await advancePreapprovals(db);
  await w.premerge(1, "clean", false);
  for (let i = 0; i < 3; i++) { await advanceWorkflows(db); await advancePreapprovals(db); }

  let token: string | null = null, asked = 0;
  const lane: LaneDeps = {
    vault: { userToken: async () => { asked++; return token ? { ok: true, access: token } : { ok: false, needsSignIn: true, why: "no-token" }; } },
    permission: async () => "write",
  };
  const merge = () => runMerge(db, { repo: "app", dryRun: false, by: "pipeline" }, quiet, { ...w.gh.mergeDeps(), now: () => new Date(), lane });
  const mergesPlanned = async () => (await planned(db, "merge", { repo: "app" })).length;
  const action = async () => (await loadActions(db, { refs: [{ repo: "app", number: 1 }], kinds: ["merge"] })).get("app#1")?.[0];

  assert.equal(await mergesPlanned(), 1);
  assert.deepEqual((await merge()).merged, []);
  assert.deepEqual(w.gh.writesOf("merge"), []);
  const row = await action();
  assert.deepEqual([row?.state, row?.by, row?.head], ["waiting-token", APPROVER, "sha1"]);
  assert.match(await legWait(db, (await liveWorkflow(db, "app", item))!) ?? "", /mira to sign in/);
  assert.equal(row?.workflow_id, (await liveWorkflow(db, "app", item))!.id);
  assert.equal(await mergesPlanned(), 0);
  const before = asked;
  await merge();
  assert.equal(asked, before, "a waiting merge asks for no token");

  // Approving it again tries it once more; anyone else's approval of the approved merge runs nothing.
  const approve = async (who: Actor) => (await runCommand(db, who, "dashboard", { parsed: parse("merge"), items: [{ repo: "app", number: item }] })).items[0]!;
  await db.run(db.k.insertInto("main.access").values({ login: "ann", role: "operator" }));
  assert.equal((await approve({ login: "ann", canWrite: async () => true })).outcome, "refused");
  assert.equal(await mergesPlanned(), 0);
  const o = await approve(actor);
  assert.equal(o.outcome, "run", o.line);
  assert.equal(await mergesPlanned(), 1);
  for (let i = 0; i < 2; i++) await merge();
  assert.deepEqual([asked - before, (await action())?.state, await mergesPlanned()], [1, "waiting-token", 0]);

  token = "user-token";
  assert.equal(await retryWaiting(db, APPROVER), 1);
  assert.equal(await mergesPlanned(), 1);
  assert.deepEqual((await merge()).merged, ["app#1"]);
  assert.equal((await action())?.state, "done");
});
