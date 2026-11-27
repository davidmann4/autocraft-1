import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pushedByAutoCraft, writesOf } from "../src/dash/api/github-writes.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });

test("writes match their comment by url, review id, then by time when the url is missing", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "gh-writes-test-")), "t.db"));
  await db.run(db.k.insertInto("settings").values({ key: "pipeline_login", value: "bot" }).onConflict((oc) => oc.column("key").doUpdateSet({ value: "bot" })));
  const audit = (at: string, action: string, details: object) => ({ at, login: "x", action, target: "r#1", details: JSON.stringify(details) });
  await db.run(db.k.insertInto("audit").values([
    audit("2026-01-01T10:00:00Z", "act-comment", { state: "done", url: "u1", identity: "app", jobId: 7 }),
    audit("2026-01-01T11:00:00Z", "review-post", { state: "done", review: "R1" }),
    audit("2026-01-01T12:00:00Z", "act-comment", { state: "done" }),
    audit("2026-01-01T14:00:00Z", "fixup-comment-edit", { state: "done" }),
    audit("2026-01-01T13:00:00Z", "fixup-push", { state: "done", commit: "abc" }),
  ]));
  const comment = (id: string, kind: string, url: string | null, created_at: string, author: string) => ({ repo: "r", number: 1, id, kind, url, created_at, author });
  await db.run(db.k.insertInto("comments").values([
    comment("C1", "comment", "u1", "2026-01-01T10:00:30Z", "bot"),
    comment("R1", "review", null, "2026-01-01T11:00:10Z", "bot"),
    comment("C3", "comment", "u3", "2026-01-01T12:01:00Z", "bot"),
    comment("C5", "comment", null, "2026-01-01T12:00:30Z", "someone"),
    comment("C4", "comment", null, "2026-01-01T12:30:00Z", "bot"),
    comment("C6", "comment", null, "2026-01-01T14:00:20Z", "bot"),
  ]));
  const w = await writesOf(db, "r", 1);
  assert.deepEqual(w.map((x) => x.comment?.id ?? null), ["C1", "R1", "C3", null, null]);
  assert.equal(w[0]!.jobId, 7);
  assert.equal(await pushedByAutoCraft(db, "r", 1, "abc"), true);
  assert.equal(await pushedByAutoCraft(db, "r", 1, "zzz"), false);
});
