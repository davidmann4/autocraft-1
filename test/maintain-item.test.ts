import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ask } from "../src/decisions.ts";
import { item } from "../src/dash/api/maintain-item.ts";
import type { Req } from "../src/dash/types.ts";
import { connectDb } from "../src/db/open.ts";
import { insertWorkflow } from "../src/workflow/store.ts";
import { SCRATCH } from "./scratch.ts";

const as = (role: "viewer" | "maintainer"): Req => ({
  method: "GET", path: "", params: { repo: "open-app", n: "2" }, query: new URLSearchParams(), form: new URLSearchParams(), csrf: "", nonce: "",
  user: { login: role === "viewer" ? "v" : "m", role, canWrite: async () => role === "maintainer", canRead: async () => true },
});

test("the item page read gives a viewer no security findings or withdrawn questions, and a maintainer both", async () => {
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
  await ask(db, [{ id: "open-app#2:merge@h1~replaced-flip-1", kind: "merge", repo: "open-app", number: 2, question: "Merge this PR?", options: [{ key: "merge", label: "Merge" }, { key: "hold", label: "Hold" }], recommended: "merge", summary: "s" }]);
  await insertWorkflow(db, { repo: "open-app", number: 2, kind: "pr", entry: "review", state: "running", startedBy: "m", startedAt: now, startedVia: "dashboard" });

  const viewer = await item(db, as("viewer"));
  assert.ok(viewer.status, "a viewer still reads where the item stands");
  assert.deepEqual(viewer.security, []);
  assert.deepEqual(viewer.withdrawn, []);
  assert.equal(viewer.canAct, false);

  const maintainer = await item(db, as("maintainer"));
  assert.ok(maintainer.security.length > viewer.security.length);
  assert.ok(maintainer.withdrawn.length > viewer.withdrawn.length);
  assert.equal(maintainer.canAct, true);
});
