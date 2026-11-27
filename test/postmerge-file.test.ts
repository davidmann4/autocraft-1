// Filing post-merge defects: a create that sent nothing is not a try, and a row a stopped process left in `filing` is settled from its audit row.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { HELD_STUCK_MS } from "../src/conversations/held.ts";
import { savePostmerge } from "../src/data/review/index.ts";
import type { Exec, ExecResult } from "../src/fixup/git.ts";
import { runPostmergeFile } from "../src/postmerge/file.ts";
import { LANES } from "../src/runner/autopilot.ts";
import { failsBegin } from "./helpers/fails-begin.ts";
import { world, type World } from "./world-db.ts";

let current: World | null = null;
afterEach(() => current?.close());

const REVIEWED = new Date(Date.now() - 24 * 3_600_000).toISOString();
const defect = (title: string, line: number) => ({ severity: "defect" as const, title, body: "The last line is dropped.", file: null, line, scenario: null, duplicate_of: null });

async function filing(titles: string[]) {
  const w = current = await (await (await world()).repo()).pr(1);
  await w.db.run(w.db.k.updateTable("items").set({ state: "MERGED", merged_at: REVIEWED }).where("repo", "=", "app").where("number", "=", 1));
  await savePostmerge(w.db, [{ repo: "app", number: 1, merge_sha: "m1", at: REVIEWED, model: "opus", run_id: "r", findings: titles.map((t, i) => defect(t, i * 100)) as never, error: null }]);
  const gh = { creates: 0, answer: null as ExecResult | null };
  const exec: Exec = async (_cmd, args) => {
    if (args[1] !== "create") return { code: 0, stdout: "", stderr: "" };
    gh.creates++;
    return gh.answer ?? { code: 0, stdout: `https://github.com/storytold/app/issues/${100 + gh.creates}\n`, stderr: "" };
  };
  const run = (db = w.db) => runPostmergeFile(db, { repo: "app" }, () => {}, { exec, now: () => new Date(), fileExists: async () => true });
  const rows = async () => (await w.db.all(w.db.k.selectFrom("postmerge_followups").select(["state", "attempts", "issue_number"]).orderBy("finding"))).map((r) => [r.state, Number(r.attempts), r.issue_number === null ? null : Number(r.issue_number)]);
  return { w, gh, run, rows };
}

test("a failure before the request and a rate limit count no try and stop the run; the next run files every defect", async () => {
  const { w, gh, run, rows } = await filing(["Parser drops a line", "Export loses the colour"]);
  const failed = await run(failsBegin(w.db));
  assert.match(failed.later ?? "", /connection lost/);
  assert.deepEqual([gh.creates, await rows()], [0, [["skipped-limit", 0, null]]]);
  gh.answer = { code: 1, stdout: "", stderr: "GraphQL: API rate limit already exceeded for user ID 1." };
  assert.match((await run()).later ?? "", /rate limit/);
  assert.deepEqual([gh.creates, await rows()], [1, [["skipped-limit", 0, null]]]);
  gh.answer = null;
  assert.equal((await run()).filed.length, 2);
  assert.deepEqual((await rows()).map((r) => r[0]), ["filed", "filed"]);
});

test("a rate limit leaves a failed defect's try count as it was", async () => {
  const { w, gh, run, rows } = await filing(["Parser drops a line"]);
  gh.answer = { code: 1, stdout: "", stderr: "HTTP 403: forbidden" };
  await run();
  assert.deepEqual(await rows(), [["failed", 1, null]]);
  await w.db.run(w.db.k.updateTable("postmerge_followups").set({ at: new Date(Date.now() - 2 * 3_600_000).toISOString() }));
  gh.answer = { code: 1, stdout: "", stderr: "GraphQL: API rate limit already exceeded for user ID 1." };
  await run();
  assert.deepEqual(await rows(), [["failed", 1, null]]);
});

test("a row left in filing is filed when its audit row names the issue, tried again when nothing was sent, and kept while the outcome is unknown", async () => {
  const { w, gh, run, rows } = await filing(["Parser drops a line", "Export loses the colour", "Undo skips a step"]);
  const due = async () => (await LANES.find((l) => l.name === "postmerge-file")!.detect(w.db, { run: null, tracked: ["app"], wake: [] } as never)).length;
  const at = new Date(Date.now() - HELD_STUCK_MS / 2).toISOString();
  for (const finding of [0, 1, 2]) await w.db.run(w.db.k.insertInto("postmerge_followups").values({ repo: "app", number: 1, review_at: REVIEWED, finding, title: "t", state: "filing", at, attempts: 1 }));
  const audit = (finding: number, details: object) => w.db.run(w.db.k.insertInto("audit").values({ at, login: "postmerge-file", action: "postmerge-file", target: "app#1", details: JSON.stringify({ finding, ...details }) }));
  await audit(0, { state: "done", url: "https://github.com/storytold/app/issues/7" });
  await audit(1, { state: "started" });
  await run();
  assert.deepEqual([await due(), gh.creates, (await rows()).map((r) => r[0])], [0, 0, ["filing", "filing", "filing"]], "a create may still be running");

  await w.db.run(w.db.k.updateTable("postmerge_followups").set({ at: new Date(Date.now() - 2 * HELD_STUCK_MS).toISOString() }));
  assert.equal(await due(), 1);
  await run();
  assert.deepEqual([gh.creates, await rows()], [1, [["filed", 1, 7], ["filing", 1, null], ["filed", 1, 101]]]);
  assert.equal(await due(), 0, "the unknown one makes no job");
});
