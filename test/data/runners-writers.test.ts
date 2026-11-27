// Behaviour of the runners module's writers whose logic changed shape: picks, the check relay, helper rows, drop batches and settings reads.
import assert from "node:assert/strict";
import { queryDb } from "../../src/db/query-db.ts";
import { addHelper, addPassages, finishChecks, hasFreshRunners, loadHelpers, loadPassageCount, loadPickContext, loadRelayedCheckTexts, loadUserSettings, noteDrops, refuseChecks, requestCheck,
  saveHelperStatus, savePick, takeRequestedChecks, loadCheckResult, PICKS_MAX } from "../../src/data/runners/index.ts";
import { both, NOW, primeSnapshot, seedCall, seedRunners } from "./runners-helpers.ts";

both("savePick: one user's live pick holds a call, another user is refused, and a user holds at most `max` picks", async ({ db }) => {
  await seedRunners(db, 2);
  const [a, b, c] = [await seedCall(db), await seedCall(db), await seedCall(db)];
  const pick = (login: string, callId: number, max = 2) => savePick(db, { callId, login, cap: 60_000, max, now: NOW });
  assert.equal(await pick("u0", a), "picked");
  assert.equal(await pick("u1", a), "taken");
  assert.equal(await pick("u0", a), "picked", "the picker may pick again");
  assert.equal(await pick("u0", b), "picked");
  assert.equal(await pick("u0", c), "limit");
  await primeSnapshot(db);
  const ctx = await loadPickContext(db, "u0", a, NOW);
  assert.equal(ctx.callState, "queued");
  assert.equal(ctx.call?.pickedBy, "u0");
  assert.equal(ctx.livePicks, 2);
  assert.ok(ctx.pickerLogins.includes("u0"));
  assert.equal(ctx.max, PICKS_MAX);
  assert.ok(ctx.cap !== null && ctx.cap > 0);
});

both("savePick: a pick whose time is up or whose picker cannot take calls no longer holds the call", async ({ db }) => {
  await seedRunners(db, 2);
  const q = queryDb(db);
  const timed = await seedCall(db, { pickedBy: "u0", pickUntil: NOW - 1 });
  assert.equal(await savePick(db, { callId: timed, login: "u1", cap: null, max: 8, now: NOW }), "picked");
  const idle = await seedCall(db, { pickedBy: "u0", pickUntil: null });
  assert.equal(await savePick(db, { callId: idle, login: "u1", cap: null, max: 8, now: NOW }), "taken", "u0 is ready, its pick counts");
  await q.run(q.k.deleteFrom("main.remote_helpers").where("login", "=", "u0"));
  assert.equal(await savePick(db, { callId: idle, login: "u1", cap: null, max: 8, now: NOW }), "picked", "u0 has no runner, its pick does not count");
});

both("check relay: a request is taken once under the call's lease run and a refusal is not overwritten by a late result", async ({ db }) => {
  const call = await seedCall(db, { state: "leased" });
  const q = queryDb(db);
  await q.run(q.k.updateTable("main.remote_calls").set({ run_id: null }).where("id", "=", call));
  const first = await requestCheck(db, { id: call, runId: null }, JSON.stringify({ command: "a" }), NOW);
  const second = await requestCheck(db, { id: call, runId: null }, JSON.stringify({ command: "b" }), NOW);
  const stale = await requestCheck(db, { id: call, runId: 99 }, JSON.stringify({ command: "old" }), NOW);
  assert.deepEqual((await takeRequestedChecks(db, call)).map((c) => c.id), [first, second]);
  assert.deepEqual(await takeRequestedChecks(db, call), [], "taken only once");
  await refuseChecks(db, { id: stale }, "refused: the lease is gone", NOW);
  await finishChecks(db, [{ id: first, result: JSON.stringify({ text: "ok" }) }, { id: stale, result: JSON.stringify({ text: "late" }) }], NOW);
  assert.equal((await loadCheckResult(db, first))?.state, "done");
  assert.match((await loadCheckResult(db, stale))!.result!, /refused/);
  assert.deepEqual(await loadRelayedCheckTexts(db, call, null), ["ok", ""]);
});

both("helpers: a helper made at device login has no status until its first report, and a later report keeps the machine", async ({ db }) => {
  const [id] = await seedRunners(db, 1);
  const q = queryDb(db);
  await q.run(q.k.deleteFrom("main.remote_helpers"));
  const machine = { hostname: "box", platform: "linux", arch: "x64" };
  await addHelper(db, { tokenId: id!, login: "u0", machine, helperVersion: "1.5.0" });
  let [info] = (await loadHelpers(db, ["U0"], NOW)).get("u0")!;
  assert.equal(info!.readiness, null);
  assert.equal(info!.fresh, false);
  assert.deepEqual(info!.machine, machine);
  assert.equal((await hasFreshRunners(db, ["u0"], NOW)).size, 0);
  await saveHelperStatus(db, id!, "u0", { readiness: "ready", harness: "claude", models: { top: "m" }, reserve: { fiveHour: 20, weekly: 20 }, slots: 2, busy: 0 }, NOW);
  [info] = (await loadHelpers(db, ["u0"], NOW)).get("u0")!;
  assert.equal(info!.readiness, "ready");
  assert.equal(info!.fresh, true);
  assert.deepEqual(info!.machine, machine);
  assert.equal(info!.helperVersion, "1.5.0");
  assert.equal((await hasFreshRunners(db, ["u0"], NOW)).size, 1);
});

both("noteDrops: a token's drops, and one call lost again by a login, count once in a batch", async ({ db }) => {
  const q = queryDb(db);
  const rows = async () => (await q.all(q.k.selectFrom("main.remote_lease_drops").select(["token_id", "call_id"]).orderBy("token_id").orderBy("call_id"))).map((r) => `${r.token_id}:${r.call_id}`);
  assert.deepEqual(await noteDrops(db, [{ tokenId: 1, login: "u0", callId: 10 }, { tokenId: 1, login: "u0", callId: 11 }, { tokenId: 2, login: "u0", callId: 10 }], NOW), []);
  assert.deepEqual(await rows(), ["1:10"]);
  assert.deepEqual(await noteDrops(db, [{ tokenId: 3, login: "u1", callId: 12 }], NOW), []);
  assert.deepEqual(await rows(), ["1:10", "3:12"]);
});

both("loadUserSettings: raw values with defaults, the stored `fast` item choice read as `started`", async ({ db }) => {
  const q = queryDb(db);
  const at = "2026-06-01T00:00:00.000Z";
  await q.run(q.k.insertInto("main.user_settings").values([
    { login: "Ann", key: "task_items", value: "fast", updated_at: at }, { login: "Ann", key: "max_calls", value: "3", updated_at: at }, { login: "Ann", key: "manual_only", value: "1", updated_at: at },
    { login: "Ann", key: "repos", value: JSON.stringify(["b", "a"]), updated_at: at }, { login: "Ann", key: "reserve_weekly", value: "50", updated_at: at },
  ]));
  const s = await loadUserSettings(db, ["ann", "nobody"]);
  assert.deepEqual(s.get("ann"), { reserve: { fiveHour: 20, weekly: 50 }, repos: ["a", "b"], maxCalls: 3, interactiveSlots: null, manualOnly: true, skipTasks: [], taskItems: "started", runnerPrivate: false });
  assert.equal(s.get("nobody")!.manualOnly, false);
  assert.equal(s.get("nobody")!.maxCalls, null);
});

both("passages: rows added in one insert are counted per call and run", async ({ db }) => {
  const call = await seedCall(db, { state: "leased" });
  await addPassages(db, [1, 2, 3].map((i) => ({ callId: call, runId: null, login: "u0", repo: "org/docs", passageId: i, page: `p${i}`, at: NOW })));
  await addPassages(db, []);
  assert.equal(await loadPassageCount(db, call, null), 3);
  assert.equal(await loadPassageCount(db, call, 7), 0);
});
