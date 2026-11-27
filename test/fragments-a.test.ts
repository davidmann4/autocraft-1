// The quiet pull request fragment selects the PRs of a landing security finding and of a remembered quiet PR whose
// finding is not published, with the NULL handling of the rows it is joined to.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "./helpers/raw-db.ts";
import { quietPrExpr } from "../src/data/security/fragments.ts";
import { testDatabase, type TestDatabase } from "./test-db.ts";

const T0 = "2026-01-01T00:00:00Z";

let t: TestDatabase;
let db: Db;

before(async () => {
  t = await testDatabase();
  db = await t.open({ app: true });
  const k = db.k;
  await db.run(k.insertInto("main.tracked_repos").values([{ name: "app", pipeline: 1 }]));
  const item = (number: number) => ({ repo: "app", number, kind: "pr", state: "OPEN", author: "alice", head_oid: `h${number}` });
  await db.run(k.insertInto("main.items").values([11, 12, 15, 16].map(item)));
  const finding = (number: number, state: string, fix_pr: number | null) => ({ repo: "app", number, scan_id: 1, area: "a", title: "t", severity: "high", state, refs: "[]", reach: "r", impact: "i", fingerprint: `f${number}`, created_at: T0, updated_at: T0, fix_pr });
  await db.run(k.insertInto("main.security_findings").values([finding(1, "landing", 11), finding(2, "open", null), finding(3, "published", null)]));
  await db.run(k.insertInto("main.security_quiet_prs").values([{ repo: "app", pr: 15, finding: 2 }, { repo: "app", pr: 16, finding: 3 }]));
});
after(async () => t.close());

test("quietPrExpr keeps the PRs of a landing finding and of a remembered quiet PR whose finding is not published", async () => {
  const rows = await db.all(db.k.selectFrom("items as i").select(["i.repo", "i.number"]).where((eb) => quietPrExpr(eb, "i.repo", "i.number")).orderBy("i.repo").orderBy("i.number"));
  assert.deepEqual(rows.map((r) => `${r.repo}#${r.number}`), ["app#11", "app#15"]);
});
