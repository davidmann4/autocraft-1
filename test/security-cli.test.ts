// The security CLI acts only on test repos as operators.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { addLogin } from "../src/access.ts";
import { setTestRepo } from "../src/data/control/index.ts";
import { requireSessionOperator } from "../src/security/cli.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

test("the session refuses a repo that is not a test repo and a login that is not an operator", async () => {
  const db = await connectDb(join(SCRATCH, "cli.db"));
  await db.run(db.k.insertInto("main.tracked_repos").values({ name: "repo1", added_by: "cli", added_at: "x" }).onConflict((oc) => oc.doNothing()));
  await addLogin(db, "cli", "op1", "operator", null);
  await addLogin(db, "cli", "view1", "viewer", null);
  await assert.rejects(async () => await requireSessionOperator(db, "repo1", "op1"), /not marked as a test repo/);
  await setTestRepo(db, "repo1", true, "cli");
  await assert.rejects(async () => await requireSessionOperator(db, "repo1", "view1"), /not an operator/);
  assert.equal(await requireSessionOperator(db, "repo1", "op1"), "op1");
});
