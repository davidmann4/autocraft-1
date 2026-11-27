import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { item, stepsOf } from "../src/dash/api/maintain-item.ts";
import type { ItemWorkflow } from "../src/workflow/types.ts";
import type { Req } from "../src/dash/types.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { listWorkflows } from "../src/data/workflow/index.ts";
import { insertWorkflow, updateWorkflow } from "../src/workflow/store.ts";
import { SCRATCH } from "./scratch.ts";

const as = (role: "viewer" | "maintainer"): Req => ({
  method: "GET", path: "", params: { repo: "open-app", n: "2" }, query: new URLSearchParams(), form: new URLSearchParams(), csrf: "", nonce: "",
  user: { login: role === "viewer" ? "v" : "m", role, canWrite: async () => role === "maintainer", canRead: async () => true },
});

test("the item page read gives a viewer no security findings, and a maintainer gets them", async () => {
  mkdirSync(SCRATCH, { recursive: true });
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "maintain-item-")), "dash.db"));
  const now = new Date().toISOString();
  await db.run(db.k.insertInto("tracked_repos").values({ name: "open-app", pipeline: 1, workflow: "new" }));
  await db.run(db.k.insertInto("repos").values({ name: "open-app", visibility: "public" }));
  await db.run(db.k.insertInto("main.items").values({ repo: "open-app", number: 2, kind: "pr", state: "OPEN", title: "Fix", body: "", head_oid: "h2", author: "a", created_at: now, updated_at: now }));
  await db.run(db.k.insertInto("security_scans").values({ id: 7, repo: "open-app", state: "done", started_by: "boss", started_at: now }));
  await db.run(db.k.insertInto("security_findings").values({
    repo: "open-app", number: 7, scan_id: 7, area: "a", title: "Path escape", severity: "high", urgent: 0, state: "landing", refs: "[]", reach: "r", impact: "i", fingerprint: "fp7", fix_pr: 2, created_at: now, updated_at: now,
  }));
  await insertWorkflow(db, { repo: "open-app", number: 2, kind: "pr", entry: "review", state: "running", startedBy: "m", startedAt: now, startedVia: "dashboard" });

  const viewer = await item(db, as("viewer"));
  assert.ok(viewer.status, "a viewer still reads where the item stands");
  assert.deepEqual(viewer.security, []);
  assert.equal(viewer.canAct, false);

  const maintainer = await item(db, as("maintainer"));
  assert.ok(maintainer.security.length > viewer.security.length);
  assert.equal(maintainer.canAct, true);

  // A blocker's recommendation shows like any other, and a viewer reads none of the landing fix.
  const id = (await listWorkflows(db, { refs: [{ repo: "open-app", number: 2 }] }))[0]!.id;
  await updateWorkflow(db, id, { state: "blocked", blocker: "failed-twice", rec: { text: "Try the fix-up again, then merge.", parts: { fix: [], drop: [] }, merges: true, again: "fixup" } });
  assert.match((await item(db, as("maintainer"))).status!.rec ?? "", /^Try the fix-up again, then merge\. Reply yes/);
  assert.equal((await item(db, as("viewer"))).status!.rec, null);
});

test("the steps of a stuck implementation say what Try again runs, and number no fix-up after its option", () => {
  const question = { implementation: 1, round: 2 };
  const wf = {
    kind: "issue", entry: "implement", state: "recommending", step: "implement", approvedBy: null,
    plan: [{ n: 1, title: "Try again", source: "implement", option: "try-again", question, state: "planned" }],
    rec: { text: "Start it again.", parts: { fix: [], drop: [] }, merges: false, answer: { question, option: "try-again", label: "Try again" }, question },
  } as unknown as ItemWorkflow;
  const notes = (w: ItemWorkflow) => Object.fromEntries(stepsOf(w, null)!.filter((s) => s.note).map((s) => [s.name, s.note]));
  assert.deepEqual(Object.keys(notes(wf)), ["implement"]);
  // The parts of a review are the fix-up's.
  assert.deepEqual(notes({ ...wf, state: "running", step: "fix-up", rec: null, plan: [{ n: 1, title: "Check the length", source: "review", state: "planned" }] }), { "fix-up": "1" });
});
