// A pool asking the user-local room starts later units whose repos have room instead of waiting on the first, and never starts
// a unit no Task Runner may take: once only such units are left, it ends without them.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { poolRoom, repoBatches, takersFirst, type PoolRoom } from "../src/agents/call.ts";
import { pool, runHaiku, setRunner } from "../src/classify/run.ts";
import type { Item } from "../src/classify/parse.ts";
import { pruneJevUnsure, runTiered } from "../src/agents/step.ts";
import { PRIORITY } from "../src/agents/steps.ts";
import { setJevEnabled } from "../src/agents/jev.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { parseStatus, storeStatus } from "../src/remote/helpers.ts";
import { setUserRepos } from "../src/remote/my-repos.ts";
import { setManualOnly } from "../src/remote/manual-only.ts";
import { enqueueCall } from "../src/remote/calls.ts";
import { CALLER_STALE_MS } from "../src/remote/room.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });

test("a pool skips a unit nobody may take and runs the later ones", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "pool-skip-")), "t.db"));
  await db.run(db.k.insertInto("access").values({ login: "olga", role: "operator" }));
  const id = (await createToken(db, "olga", "helper", { kind: "runner" })).row.id;
  await storeStatus(db, id, "olga", parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
  await db.run(db.k.updateTable("mcp_tokens").set({ idle_claim_at: Date.now() }).where("id", "=", id));
  await setUserRepos(db, "olga", ["deckcraft"]);

  const repos = ["photocraft", "deckcraft", "deckcraft"];
  const started: number[] = [];
  await pool(repos.map((_, i) => async () => { started.push(i); }), poolRoom(db, (i) => [repos[i]!], (i) => [{ repo: repos[i]!, number: i + 1 }]), { first: true, pollMs: 5 });
  assert.deepEqual(started, [1, 2], "the deckcraft units ran; the photocraft unit never started and the pool ended");

  // Work no Task Runner may take is neither counted as sent nor stored as answered.
  const photo = [{ repo: "photocraft", number: 7, kind: "issue", title: "t", body: "" }] as unknown as Item[];
  assert.equal(await runHaiku(db, "run-1", photo), 0, "no item of a skipped batch counts as sent");
  await setJevEnabled(db, false, "test");
  const t = await runTiered(db, PRIORITY, photo);
  assert.deepEqual([...t.skipped], ["photocraft#7"]);
  assert.equal(t.alone.size + t.haiku.size, 0, "a skipped item is not one Haiku decided alone");
});

test("a pool waiting for room wakes when a Task Runner's user changes a setting, and not before", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "pool-skip-")), "t.db"));
  await db.run(db.k.insertInto("access").values({ login: "olga", role: "operator" }));
  const id = (await createToken(db, "olga", "helper", { kind: "runner" })).row.id;
  await storeStatus(db, id, "olga", parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
  const room = poolRoom(db, () => ["deckcraft"], () => [{ repo: "deckcraft", number: 1 }]);
  await room.room(0);
  const stop = new AbortController();
  let woke = false;
  const wait = room.changed(5, stop.signal).then(() => { woke = true; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(woke, false, "nothing that moves the room changed");
  const at = Date.now();
  await setManualOnly(db, "olga", true);
  await wait;
  stop.abort();
  assert.ok(Date.now() - at < 1_000, "the setting is seen at the next poll of the counters");
});

test("a pool with its most jobs running waits for one to end, past the moment its last reading said the room rises", { timeout: 20_000 }, async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "pool-skip-")), "t.db"));
  await db.run(db.k.insertInto("access").values({ login: "olga", role: "operator" }));
  const id = (await createToken(db, "olga", "helper", { kind: "runner" })).row.id;
  await storeStatus(db, id, "olga", parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
  // A queued call whose caller goes stale in a moment: the reading says the room rises then.
  const call = await enqueueCall(db, { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", askedModel: "opus", bundle: { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", timeoutSeconds: 600, maxTurns: 10, stdin: "x", system: null, mounts: [], mcpServers: [], keepSession: false, hints: {} } as never, items: [{ repo: "deckcraft", number: 9 }], level: 0, maxAttempts: 2 });
  await db.run(db.k.updateTable("remote_calls").set({ seen_at: Date.now() - CALLER_STALE_MS + 30 }).where("id", "=", call));
  const ended: number[] = [];
  await pool([0, 1].map((i) => () => new Promise<void>((r) => setTimeout(() => { ended.push(i); r(); }, 200))), poolRoom(db, () => ["deckcraft"], (i) => [{ repo: "deckcraft", number: i + 1 }]), { max: 1, pollMs: 5 });
  assert.deepEqual(ended, [0, 1]);
});

test("batches hold one repo's items in the order of their first item", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "pool-skip-")), "t.db"));
  const items = ["deck:1", "photo:1", "deck:2", "deck:3", "photo:2", "deck:4", "design:1"].map((x) => ({ repo: x.split(":")[0]!, id: x }));
  const ids = async () => (await repoBatches(db, items, 2, (x) => x.repo, (x) => [{ repo: x.repo, number: Number(x.id.split(":")[1]) }])).map((b) => b.map((x) => x.id));
  assert.deepEqual(await ids(), [["deck:1", "deck:2"], ["photo:1", "photo:2"], ["deck:3", "deck:4"], ["design:1"]]);
});

test("a limited selection takes the items with a taker before the ones nobody may take", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "pool-skip-")), "t.db"));
  await db.run(db.k.insertInto("access").values({ login: "olga", role: "operator" }));
  const id = (await createToken(db, "olga", "helper", { kind: "runner" })).row.id;
  await storeStatus(db, id, "olga", parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
  await db.run(db.k.updateTable("mcp_tokens").set({ idle_claim_at: Date.now() }).where("id", "=", id));
  await setUserRepos(db, "olga", ["deckcraft"]);
  const items = [{ repo: "photocraft", n: 1 }, { repo: "deckcraft", n: 2 }, { repo: "photocraft", n: 3 }, { repo: "deckcraft", n: 4 }];
  const picked = (await takersFirst(db, items, (x) => [x.repo], (x) => [{ repo: x.repo, number: x.n }])).slice(0, 1);
  assert.deepEqual(picked, [{ repo: "deckcraft", n: 2 }]);
  assert.deepEqual((await takersFirst(db, items, (x) => [x.repo], (x) => [{ repo: x.repo, number: x.n }])).map((x) => x.n), [2, 4, 1, 3], "stable within each group, none dropped");
});

test("an unsure Jev answer whose Haiku batch nobody may take is not asked of Jev again while the item is unchanged", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "pool-skip-")), "t.db"));
  await setJevEnabled(db, true, "test");
  let asked = 0;
  const restore = setRunner(async () => {
    asked++;
    return { code: 0, stderr: "", stdout: JSON.stringify({ answers: { impact: { choice: "P2", probabilities: { P2: 0.5 } } }, usage: { input_tokens: 10, output_tokens: 1 } }) };
  });
  try {
    const item = (title: string) => [{ repo: "photocraft", number: 7, kind: "issue", title, body: "" }] as unknown as Item[];
    const first = await runTiered(db, PRIORITY, item("t"));
    assert.deepEqual([...first.skipped], ["photocraft#7"]);
    const again = await runTiered(db, PRIORITY, item("t"));
    assert.equal(asked, 1, "the kept unsure answer stands in for Jev");
    assert.deepEqual(again.jev.get("photocraft#7"), first.jev.get("photocraft#7"));
    assert.deepEqual([...again.skipped], ["photocraft#7"], "the item still waits for Haiku, unsettled");
    await runTiered(db, PRIORITY, item("t, edited"));
    assert.equal(asked, 2, "changed text is asked again");
    assert.equal(await pruneJevUnsure(db), 1, "the answer of an item that is not open in a tracked repo is dropped");
  } finally { restore(); }
});

test("a pool starts as many units as the room it read while none has queued its call, and one when there is no room", async () => {
  // The room a cached reading keeps showing while the units prepare their calls.
  const fixed = (room: number): PoolRoom => ({
    round: () => {}, room: async () => room, taker: async () => true,
    changed: (_ms, signal) => new Promise<void>((r) => { const t = setTimeout(r, 5); signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); }),
  });
  for (const [room, want] of [[2, 2], [0, 1]] as const) {
    let live = 0, most = 0;
    const unit = async (): Promise<void> => { live++; most = Math.max(most, live); await new Promise((r) => setTimeout(r, 40)); live--; };
    await pool(Array.from({ length: 5 }, () => unit), fixed(room), { pollMs: 5 });
    assert.equal(most, want, `room ${room}`);
  }
});
