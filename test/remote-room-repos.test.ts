// The user-local room counts only the Task Runners that may take a call on the caller's repos: one user's slots do not start
// jobs on repos only another user serves, and a queued call nobody may take holds no room from other repos.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { queueRoom, queueRoomPass, setCallContext } from "../src/agents/call.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { enqueueCall } from "../src/remote/calls.ts";
import { parseStatus, storeStatus } from "../src/remote/helpers.ts";
import { setUserRepos } from "../src/remote/my-repos.ts";
import { setUserTasks, TASK_CHOICES } from "../src/remote/my-tasks.ts";
import { remoteRoom } from "../src/remote/room.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { excluded } from "../src/db/kx.ts";
import { dropQueueCache } from "../src/data/runners/calls-shared.ts";
import { markHelperIdle } from "../src/data/runners/index.ts";
import type { Role } from "../src/dash/types.ts";

mkdirSync(SCRATCH, { recursive: true });

test("room is counted per repo: runners with disjoint repos, a call nobody may take", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "remote-room-repos-")), "t.db"));
  const at = new Date().toISOString();
  const runner = async (login: string, role: string) => {
    await db.run(db.k.insertInto("access").values({ login, role }));
    const id = (await createToken(db, login, "helper", { kind: "runner" })).row.id;
    await storeStatus(db, id, login, parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
    await markHelperIdle(db, { tokenId: id, login, role: role as Role }, { now: Date.now(), tiers: ["top"], repos: null });
    return id;
  };
  const perm = async (login: string, repo: string, permission: string) =>
    await db.run(db.k.insertInto("repo_permissions").values({ login, repo, permission, checked_at: at }).onConflict((oc) => oc.columns(["login", "repo"]).doUpdateSet(excluded(["permission", "checked_at"]))));
  // Rows are written directly: each question is answered from a new reading.
  const room = async (repos?: string[]) => {
    dropQueueCache(db);
    return await remoteRoom(db, 0, Date.now(), repos);
  };

  // The operator takes deckcraft and designcraft only; no permission of theirs on designcraft is cached yet.
  await runner("olga", "operator");
  await setUserRepos(db, "olga", ["deckcraft", "designcraft"]);
  await perm("olga", "deckcraft", "write");
  assert.equal(await room(["deckcraft"]), 1);
  assert.equal(await room(["designcraft"]), 1, "no cached permission yet: the runner counts");
  assert.equal(await room(["photocraft"]), 0, "not in the operator's My repos");
  assert.equal(await room([]), 1, "a call that names no repo: the operator's runner");

  const photo = await enqueueCall(db, { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", askedModel: "opus", items: [{ repo: "photocraft", number: 7 }], level: 0, maxAttempts: 1,
    bundle: { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", timeoutSeconds: 60, maxTurns: null, stdin: "x", system: null, mounts: [], mcpServers: [], keepSession: false, hints: {} } });
  assert.equal(await room(["deckcraft"]), 1, "a queued photocraft call nobody may take holds no deckcraft room");
  assert.equal(await room(), 0, "counted without repos, it does");

  // The maintainer may write to photocraft only.
  const dave = await runner("dave", "maintainer");
  await perm("dave", "photocraft", "write");
  await perm("dave", "deckcraft", "read");
  await perm("dave", "designcraft", "read");
  assert.equal(await room(["deckcraft"]), 1, "dave's slot is no deckcraft room");
  assert.equal(await room(["photocraft"]), 0, "dave's slot goes to the queued photocraft call first");
  assert.equal(await room([]), 1, "a maintainer's runner takes no call without a repo");
  await db.run(db.k.updateTable("remote_calls").set({ state: "failed" }).where("id", "=", photo));
  assert.equal(await room(["photocraft"]), 1);
  await db.run(db.k.updateTable("repo_permissions").set({ checked_at: new Date(Date.now() - 3600_000).toISOString() }).where("login", "=", "dave").where("repo", "=", "deckcraft"));
  assert.equal(await room(["deckcraft"]), 2, "a read permission confirmed an hour ago no longer leaves dave out");
  await perm("dave", "deckcraft", "read");
  assert.equal(await room(["photocraft", "deckcraft"]), 0, "nobody takes a call on both");

  // A job's repo param is added to the repos a pool names.
  await db.run(db.k.updateTable("remote_helpers").set({ idle_claim_at: null }).where("token_id", "=", dave));
  await setUserRepos(db, "olga", ["designcraft"]);
  assert.equal(await queueRoom(db, 0, ["designcraft"]), 1);
  const job = (repo: string) => setCallContext({ jobId: 1, step: "opus-review", stage: 5, repo, cancelled: async () => false });
  try {
    job("designcraft");
    assert.equal(await queueRoom(db, 0), 1);
    job("deckcraft");
    assert.equal(await queueRoom(db, 0), 0, "olga no longer takes deckcraft, and dave's runner is not active");
    assert.equal(await queueRoom(db, 0, ["designcraft"]), 0, "a call of a deckcraft job names deckcraft too");
  } finally {
    setCallContext(null);
  }
});

test("room and takers count only the runners whose users take the call's task (My tasks)", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "remote-room-tasks-")), "t.db"));
  await db.run(db.k.insertInto("access").values({ login: "olga", role: "operator" }));
  const id = (await createToken(db, "olga", "helper", { kind: "runner" })).row.id;
  await storeStatus(db, id, "olga", parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
  await markHelperIdle(db, { tokenId: id, login: "olga", role: "operator" }, { now: Date.now(), tiers: ["top"], repos: null });
  await setUserTasks(db, "olga", TASK_CHOICES.map((t) => t.id).filter((t) => t !== "review"));
  const room = async (repos: string[] | undefined, step: string) => await remoteRoom(db, 0, Date.now(), repos, step);
  assert.ok(await room(["deckcraft"], "fixissue") > 0);
  assert.equal(await room(["deckcraft"], "opus-review"), 0, "the only runner's user unticked Review");
  assert.equal(await room(undefined, "opus-review"), 0, "with no repo named as well");
  const pass = await queueRoomPass(db);
  assert.equal(await pass.taker(["deckcraft"], "opus-review"), false, "no taker for the unticked task");
  assert.equal(await pass.taker(["deckcraft"], "fixissue"), true);
  setCallContext({ jobId: 1, step: "opus-review", stage: 5, repo: "deckcraft", cancelled: async () => false });
  try {
    assert.equal(await queueRoom(db, 0, ["deckcraft"]), 0, "a review job's calls get no room");
  } finally {
    setCallContext(null);
  }
  assert.ok(await remoteRoom(db, 0, Date.now()) > 0);
  await setUserTasks(db, "olga", []);
  assert.equal(await remoteRoom(db, 0, Date.now()), 0, "with no task ticked the user takes only picks: no room for any call");
});
