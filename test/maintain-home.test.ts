// The new Home's needs-an-answer list (src/dash/api/maintain.ts): only repos where the reader may act.
import assert from "node:assert/strict";
import { test } from "node:test";
import { home } from "../src/dash/api/maintain.ts";
import { connectDb } from "../src/db/open.ts";
import { addEvent, insertWorkflow } from "../src/workflow/store.ts";

const T = "2026-11-01T00:00:00.000Z";
const as = (role: string, writable: string[]) => ({
  method: "GET", path: "", params: {}, query: new URLSearchParams(), form: new URLSearchParams(), csrf: "", nonce: "",
  user: { login: "u1", role, canWrite: async (r: string) => writable.includes(r), canRead: async () => true },
}) as never;

test("needs an answer counts only repos where the reader may act", async () => {
  const db = await connectDb(":memory:");
  for (const name of ["app", "lib"]) {
    await db.run(db.k.insertInto("repos").values({ name, visibility: "public" }));
    await db.run(db.k.insertInto("tracked_repos").values({ name, added_by: "op", added_at: T, pipeline: 1 }));
  }
  const rec = { text: "Fix 1, then merge?", parts: { fix: [1], drop: [] }, merges: true };
  const wf = { kind: "pr" as const, entry: "review" as const, startedBy: "m2", startedAt: T, startedVia: "github" as const };
  await insertWorkflow(db, { ...wf, repo: "app", number: 1, state: "recommending", rec });
  await insertWorkflow(db, { ...wf, repo: "lib", number: 2, state: "recommending", rec });
  // An unclear answer on a running item waits for a person too.
  const running = await insertWorkflow(db, { ...wf, repo: "app", number: 3, state: "running" });
  await addEvent(db, { workflowId: running, repo: "app", number: 3, login: "m2", via: "github", kind: "ambiguous" });
  await insertWorkflow(db, { ...wf, repo: "app", number: 4, state: "running" });

  const refs = (rows: { repo: string; number: number }[]) => rows.map((r) => `${r.repo}#${r.number}`).sort();
  assert.deepEqual(refs((await home(db, as("maintainer", ["app"]))).needs), ["app#1", "app#3"]);
  assert.deepEqual(refs((await home(db, as("maintainer", []))).needs), []);
  assert.deepEqual(refs((await home(db, as("operator", []))).needs), ["app#1", "app#3", "lib#2"]);
  const viewer = await home(db, as("viewer", ["app", "lib"]));
  assert.deepEqual(refs(viewer.needs), []);
  assert.deepEqual(refs(viewer.waiting), ["app#1", "app#3", "lib#2"]);
});
