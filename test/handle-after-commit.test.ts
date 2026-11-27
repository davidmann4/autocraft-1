import { test } from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./test-db.ts";

test("afterCommit runs its callbacks in order once the outer write commits, drops them on rollback, and runs at once outside a write", async () => {
  const tdb = await testDatabase("CREATE TABLE t (id INTEGER PRIMARY KEY)");
  try {
    const db = await tdb.open();
    const ran: string[] = [];
    await db.write(async () => {
      db.afterCommit(() => void ran.push("outer"));
      await db.write(async () => db.afterCommit(() => void ran.push("nested")));
      db.afterCommit(() => {
        throw new Error("logged, not thrown");
      });
      assert.deepEqual(ran, [], "nothing runs before the commit");
    });
    assert.deepEqual(ran, ["outer", "nested"]);

    await assert.rejects(db.write(async () => {
      db.afterCommit(() => void ran.push("rolled back"));
      throw new Error("roll back");
    }));
    db.afterCommit(() => void ran.push("outside"));
    assert.deepEqual(ran, ["outer", "nested", "outside"]);
  } finally {
    await tdb.close();
  }
});
