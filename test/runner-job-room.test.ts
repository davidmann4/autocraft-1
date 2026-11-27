// The runner's job starts count Task Runner room per user: a queued call holds a slot of one user who would take it, so calls
// only one user takes, or nobody takes, do not use up another user's room, and a lane job counts the runner of the person who
// started its pull request.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { enqueueCall } from "../src/remote/calls.ts";
import { parseStatus, storeStatus } from "../src/remote/helpers.ts";
import { setManualOnly } from "../src/remote/manual-only.ts";
import { setUserRepos } from "../src/remote/my-repos.ts";
import { jobRoom, roomState } from "../src/remote/room.ts";
import { jobCalls } from "../src/runner/runner.ts";
import { dropQueueCache } from "../src/data/runners/calls-shared.ts";
import { dropSnapshotCache, markHelperIdle } from "../src/data/runners/index.ts";
import type { Role } from "../src/dash/types.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });

test("job room per user: calls one user or nobody takes leave the others' room, and a lane job counts its starter's runner", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "runner-job-room-")), "t.db"));
  const runner = async (login: string, role: Role, repos: string[]) => {
    await db.run(db.k.insertInto("access").values({ login, role }));
    const id = (await createToken(db, login, "helper", { kind: "runner" })).row.id;
    // Two slots: one for calls, the other the fast lane, which is no room.
    await storeStatus(db, id, login, parseStatus({ slots: 2, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
    await markHelperIdle(db, { tokenId: id, login, role }, { now: Date.now(), tiers: ["top"], repos: null });
    await setUserRepos(db, login, repos);
  };
  await runner("olga", "operator", ["deckcraft", "photocraft"]);
  await runner("dave", "maintainer", ["photocraft"]);
  // Nora's runner takes only work she started: her merge workflow on designcraft#3260, whose steps include the review of a model-written push.
  await runner("nora", "maintainer", ["designcraft"]);
  await setManualOnly(db, "nora", true);
  const at = new Date().toISOString();
  await db.run(db.k.insertInto("item_workflows").values({ repo: "designcraft", number: 3260, kind: "pr", entry: "merge", weight: 5, state: "running", started_by: "nora", approved_by: "nora", started_at: at, started_via: "github", plan: "[]", updated_at: at } as never));
  const call = (repo: string, number: number) => enqueueCall(db, { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", askedModel: "opus", items: [{ repo, number }], level: 0, maxAttempts: 1,
    bundle: { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", timeoutSeconds: 60, maxTurns: null, stdin: "x", system: null, mounts: [], mcpServers: [], keepSession: false, hints: {} } });
  // Two calls only olga takes, one nobody takes.
  await call("deckcraft", 1);
  await call("deckcraft", 2);
  await call("texturecraft", 3);
  dropQueueCache(db);
  dropSnapshotCache(db);
  const rooms = jobRoom(await roomState(db));
  const job = (repo: string, extra: Record<string, unknown> = {}) => jobCalls("opus-review", repo, JSON.stringify({ repo, limit: 1, ...extra }));

  assert.equal(rooms.room(0, job("deckcraft")), 0, "olga's slot goes to the deckcraft calls");
  assert.ok(rooms.room(0, job("photocraft")) > 0, "dave's slot is not used up by calls only olga takes, nor by one nobody takes");
  assert.equal(rooms.room(0, job("texturecraft")), 0, "a repo nora started nothing in has none of her room");
  const lane = job("designcraft", { lane: "approved", number: 3260 });
  assert.ok(rooms.room(0, lane) > 0, "the lane job of nora's pull request has her runner's room");

  rooms.take(0, job("photocraft"));
  assert.equal(rooms.room(0, job("photocraft")), 0, "a started photocraft job holds dave's slot");
  assert.ok(rooms.room(0, lane) > 0, "and not nora's");
});
