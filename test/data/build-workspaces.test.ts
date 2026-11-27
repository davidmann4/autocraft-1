// Build module: workspace rows, sessions and read models. Statement counts must not grow with the number of workspaces.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import {
  addSession, addWorkspaceCalls, claimQueuedCalls, claimSession, countKeptImages, failStuckCalls, IMAGE_KEEP_MS, loadCallAccounting, loadCallResult, loadRunningCalls, loadToolCalls,
  loadWorkspaceCallSince, markCalls, pruneWorkspaceImageBatch, refuseQueuedCalls, stubImages, loadCacheReport, loadCheckpoint, loadSessions, loadWorkspaceCalls, loadWorkspacePage, loadWorkspacePass, loadWorkspaces, loadWorkspaceWarm,
  moveWorkspaces, patchSessions, patchWorkspaces, requestWorkspaces, takeCallNumber, WorkspaceError,
} from "../../src/data/build/index.ts";
import { expectFlat } from "../helpers/query-count.ts";
import { testDatabase } from "../test-db.ts";
import { both } from "./planner-helpers.ts";

const AT = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T01:00:00.000Z";
const SHA = "a".repeat(40);
const SCOPE = { hiddenRepos: [] as string[], staff: true };

async function fresh(): Promise<{ db: Db; close: () => Promise<void> }> {
  const t = await testDatabase("", "sqlite");
  return { db: await t.open({ app: true }), close: () => t.close() };
}

async function seedEnv(db: Db, id = "kube", settings: object = {}): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.build_envs").values({ id, label: id, kind: "kubernetes", slots: 1, key_hash: "x", created_at: AT, settings: JSON.stringify(settings) }));
}

const req = (repo: string, over: object = {}) => ({ repo, baseSha: SHA, envId: "kube", owner: "me", ciCheckout: false, ...over });

async function ready(db: Db, ids: number[]): Promise<void> {
  await moveWorkspaces(db, ids.map((id) => ({ id, from: ["requested"], to: "ready" as const })), AT);
}

async function addCall(db: Db, workspaceId: number, tool: string, o: { state?: string; deadline?: string; result?: object; started?: string } = {}): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.insertInto("main.workspace_calls").values({
    workspace_id: workspaceId, tool, state: o.state ?? "running", created_at: AT, started_at: o.started ?? AT, deadline_at: o.deadline ?? null, result: o.result ? JSON.stringify(o.result) : null,
  }));
}

both("requestWorkspaces refuses a warm writer or a bad row as a whole, and moveWorkspaces is a compare-and-set", async ({ db }) => {
  await seedEnv(db);
  await seedEnv(db, "writer", { warmWriter: true });
  await assert.rejects(requestWorkspaces(db, [req("a"), req("b", { envId: "writer" })], AT), (e: unknown) => e instanceof WorkspaceError && e.status === 400);
  await assert.rejects(requestWorkspaces(db, [req("a", { baseSha: "abc" })], AT), (e: unknown) => e instanceof WorkspaceError && e.status === 400);
  assert.equal((await loadWorkspaces(db, { env: "kube", states: ["requested"] })).size, 0, "nothing was recorded");
  const ids = await requestWorkspaces(db, [req("a"), req("b", { limits: { deadlineSec: 600 } })], AT);
  assert.equal(ids.length, 2);
  const rows = await loadWorkspaces(db, { ids });
  assert.equal(rows.get(ids[1]!)!.limits, JSON.stringify({ deadlineSec: 600 }));
  assert.equal(rows.get(ids[0]!)!.layout, 1);
  const moved = await moveWorkspaces(db, [{ id: ids[0]!, from: ["requested"], to: "ready", set: { pod: "p1", create_tries: 2 } }, { id: ids[1]!, from: ["requested"], to: "ready", set: { pod: "p2", create_tries: 3 } }], LATER);
  assert.deepEqual([...moved].sort(), [...ids].sort());
  const after = await loadWorkspaces(db, { ids });
  assert.equal(after.get(ids[1]!)!.pod, "p2");
  assert.equal(Number(after.get(ids[1]!)!.create_tries), 3);
  assert.equal(after.get(ids[0]!)!.state_at, LATER);
  const stale = await moveWorkspaces(db, [{ id: ids[0]!, from: ["requested"], to: "ended" }, { id: ids[1]!, from: ["ready"], to: "ended" }], LATER);
  assert.deepEqual([...stale], [ids[1]], "a row no longer in `from` does not move");
  assert.ok((await loadWorkspaces(db, { ids: [ids[1]!] })).get(ids[1]!)!.ended_at);
});

both("patchWorkspaces with `where` is a compare-and-set on the stored values, NULL included", async ({ db }) => {
  await seedEnv(db);
  const ids = await requestWorkspaces(db, [req("a"), req("b"), req("c")], AT);
  assert.equal(await patchWorkspaces(db, ids.map((id, i) => ({ id, set: { pvc: `v${i}` } }))), 3);
  const n = await patchWorkspaces(db, [
    { id: ids[0]!, where: { pvc: "v0", pod: null }, set: { pod: "p0", pvc: null } }, { id: ids[1]!, where: { pvc: "other" }, set: { pod: "p1" } },
    { id: ids[2]!, whereState: ["requested"], where: { pod: null }, set: { pod: "p2", create_tries: 4 } },
  ]);
  assert.equal(n, 2);
  assert.equal(await patchWorkspaces(db, [{ id: ids[0]!, where: { pod: null }, set: { pod: "again" } }]), 0, "the pod is set now");
  const rows = await loadWorkspaces(db, { ids });
  assert.deepEqual(ids.map((id) => [rows.get(id)!.pod, rows.get(id)!.pvc, Number(rows.get(id)!.create_tries)]), [["p0", null, 0], [null, "v1", 0], ["p2", "v2", 4]]);
});

both("loadCallAccounting reads the bookkeeping in a call's result and the limits in its arguments, whatever text they hold", async ({ db }) => {
  await seedEnv(db);
  const [w] = await requestWorkspaces(db, [req("a")], AT);
  const call = (tool: string, args: string, result: string | null, state = "done") => ({ workspace_id: w!, tool, args, state, created_at: AT, run_id: null, n: 1, result, started_at: AT, deadline_at: null, finished_at: null });
  const ids = await addWorkspaceCalls(db, [
    call("shell", '{"background":true,"timeout_sec":90}', '{"text":"x","acct":{"ms":12.5,"bytes":2147483648,"bg":1,"limit":600,"ref":7,"ended":1,"images":2}}'),
    call("shell", '{"background":false}', "cut off {", "failed"), call("shell", "not json", null, "running"), call("seed", "{}", '{"acct":{"ms":1}}'),
  ]);
  const none = { ms: null, bytes: null, bg: null, lim: null, ref: null, ended: null, images: null, timeout: null };
  assert.deepEqual(await loadCallAccounting(db, w!, ["seed"]), [
    { id: ids[0], n: 1, tool: "shell", state: "done", started_at: AT, ms: 12.5, bytes: 2147483648, bg: 1, lim: 600, ref: 7, ended: 1, images: 2, background: 1, timeout: 90 },
    { id: ids[1], n: 1, tool: "shell", state: "failed", started_at: AT, ...none, background: 0 },
    { id: ids[2], n: 1, tool: "shell", state: "running", started_at: AT, ...none, background: 0 },
  ]);
  assert.equal((await loadCallAccounting(db, w!, [])).length, 4);
});

both("patchWorkspaces sets different values per row in one call, keeps the checkpoint out of plain loads, and takeCallNumber counts", async ({ db }) => {
  await seedEnv(db);
  const ids = await requestWorkspaces(db, [req("a"), req("b"), req("c")], AT);
  const blob = new Uint8Array([1, 2, 3, 250]);
  const n = await patchWorkspaces(db, [
    { id: ids[0]!, set: { node: "n1", resume_tries: 1 } }, { id: ids[1]!, set: { node: "n2", resume_tries: 2 } },
    { id: ids[2]!, whereState: ["ready"], set: { node: "n3" } }, { id: ids[0]!, set: { checkpoint: blob, checkpoint_at: AT } },
  ]);
  assert.equal(n, 2, "rows changed: the one whose state does not match is left alone");
  const rows = await loadWorkspaces(db, { ids });
  assert.deepEqual(ids.map((id) => rows.get(id)!.node), ["n1", "n2", null]);
  assert.equal("checkpoint" in rows.get(ids[0]!)!, false);
  assert.deepEqual([...(await loadCheckpoint(db, ids[0]!))!], [...blob]);
  assert.deepEqual([...(await loadWorkspaces(db, { ids: [ids[0]!] }, { checkpoint: true })).get(ids[0]!)!.checkpoint!], [...blob]);
  assert.deepEqual([await takeCallNumber(db, ids[0]!), await takeCallNumber(db, ids[0]!)], [1, 2]);
  await assert.rejects(takeCallNumber(db, 9999), (e: unknown) => e instanceof WorkspaceError && e.status === 404);
  assert.deepEqual([...(await loadWorkspaceWarm(db, [ids[0]!, 9999])).keys()], [ids[0]]);
});

both("loadWorkspacePass reports running calls within their deadline and background shells since the pod started", async ({ db }) => {
  await seedEnv(db);
  const [a, b] = await requestWorkspaces(db, [req("a"), req("b")], AT);
  await ready(db, [a!, b!]);
  const future = new Date(Date.now() + 3600_000).toISOString();
  await addCall(db, a!, "shell", { deadline: future });
  await addCall(db, a!, "shell", { deadline: "2000-01-01T00:00:00.000Z" });
  await addCall(db, a!, "shell", { state: "done", result: { acct: { bg: 1, limit: 60, ref: 1 } } });
  await addCall(db, b!, "shell", { state: "done", started: "2000-01-01T00:00:00.000Z", result: { acct: { bg: 1 } } });
  const pass = await loadWorkspacePass(db, "kube", Date.now());
  assert.equal(pass.rows.length, 2);
  assert.equal(pass.calls.get(a!)!.running.length, 1);
  assert.equal(pass.calls.get(a!)!.background.length, 1);
  assert.equal(pass.calls.get(a!)!.background[0]!.bg, 1);
  assert.equal(pass.calls.get(b!), undefined, "a shell from before the pod started is not counted");
  assert.equal(pass.bound.size, 0);
});

test("loadWorkspacePass: statements do not grow with the number of workspaces and calls", async () => {
  await expectFlat(async (n) => {
    const { db, close } = await fresh();
    await seedEnv(db);
    const ids = await requestWorkspaces(db, Array.from({ length: n }, (_, i) => req(`r${i}`)), AT);
    await ready(db, ids);
    for (const id of ids) await addCall(db, id, "shell", { deadline: new Date(Date.now() + 3600_000).toISOString() });
    return { db, close, run: () => loadWorkspacePass(db, "kube", Date.now()) };
  }, 2, 12);
});

test("moveWorkspaces and patchWorkspaces: statements do not grow with the number of rows of one shape", async () => {
  await expectFlat(async (n) => {
    const { db, close } = await fresh();
    await seedEnv(db);
    const ids = await requestWorkspaces(db, Array.from({ length: n }, (_, i) => req(`r${i}`)), AT);
    return {
      db, close, run: async () => {
        await moveWorkspaces(db, ids.map((id) => ({ id, from: ["requested" as const], to: "ready" as const, set: { pod: `p${id}` } })), LATER);
        await patchWorkspaces(db, ids.map((id) => ({ id, set: { node: `n${id}` } })));
      },
    };
  }, 2, 12);
});

both("sessions: one job claims a session, a patch with a stale state changes nothing, and loads key by id, workspace and call", async ({ db }) => {
  const mk = (workspace_id: number | null, remote_call_id: number | null) => addSession(db, {
    kind: "try", repo: "a", base_sha: SHA, item: 1, prompt: "p", env_id: "kube", deadline_sec: 600, workspace_id, remote_call_id, requested_by: "me", created_at: AT, updated_at: AT,
  });
  const [s1, s2] = [await mk(5, 70), await mk(5, null)];
  assert.deepEqual(await claimSession(db, s1, 11), { state: "queued" });
  assert.equal(await claimSession(db, s1, 12), null, "another job's session");
  assert.deepEqual(await claimSession(db, s1, 11), { state: "queued" }, "the same job again");
  assert.equal(await patchSessions(db, [{ id: s1, whereState: ["running"], set: { state: "failed" } }, { id: s2, set: { state: "starting", outcome: "o2" } }]), 1);
  assert.equal(await patchSessions(db, [{ id: s1, whereState: ["queued"], set: { state: "running", workspace_id: 6 } }, { id: s2, whereState: ["starting"], set: { state: "running" } }]), 2);
  assert.deepEqual([...(await loadSessions(db, { workspaceIds: [5, 6] })).entries()].map(([k, v]) => [k, v.map((r) => r.id)]).sort(), [[5, [s2]], [6, [s1]]]);
  assert.deepEqual([...(await loadSessions(db, { remoteCallId: 70 })).entries()].map(([k, v]) => [k, v.map((r) => r.id)]), [[70, [s1]]]);
  assert.deepEqual([...(await loadSessions(db, { ids: [s2, s1] })).keys()], [s1, s2]);
  await patchSessions(db, [{ id: s1, set: { state: "done", ended_at: LATER } }]);
  assert.equal(await claimSession(db, s1, 11), null, "an ended session cannot be claimed");
});

both("the workspace page, call page and cache inputs respect the viewer's hidden repos and the paging cursors", async ({ db }) => {
  await seedEnv(db);
  const ids = await requestWorkspaces(db, [req("a"), req("b"), req("c")], AT);
  await moveWorkspaces(db, [{ id: ids[2]!, from: ["requested"], to: "ended" }], LATER);
  const live = await loadWorkspacePage(db, { state: "live", limit: 10 }, SCOPE);
  assert.deepEqual(live.rows.map((r) => r.repo), ["b", "a"]);
  const all = await loadWorkspacePage(db, { state: "all", limit: 2 }, SCOPE);
  assert.equal(all.rows.length, 2);
  assert.equal(all.next, String(ids[1]));
  assert.deepEqual((await loadWorkspacePage(db, { state: "all", limit: 2, cursor: all.next! }, SCOPE)).rows.map((r) => r.repo), ["a"]);
  const hidden = await loadWorkspacePage(db, { state: "all", limit: 10 }, { hiddenRepos: ["b"], staff: false });
  assert.deepEqual(hidden.rows.map((r) => r.repo), ["c", "a"]);
  const allowed = await loadWorkspacePage(db, { state: "all", limit: 10 }, { hiddenRepos: Object.assign([] as string[], { visible: ["a"] }), staff: false });
  assert.deepEqual(allowed.rows.map((r) => r.repo), ["a"]);

  for (let i = 0; i < 5; i++) await addCall(db, ids[0]!, i === 0 ? "own" : "shell", { state: "done", result: { text: "t", isError: false } });
  const page = await loadWorkspaceCalls(db, ids[0]!, { limit: 2, ownTools: ["own"] });
  assert.equal(page.rows.length, 2);
  assert.equal(page.more, true);
  assert.ok(page.rows[0]!.id < page.rows[1]!.id, "oldest first within the page");
  const older = await loadWorkspaceCalls(db, ids[0]!, { limit: 10, before: page.rows[0]!.id, ownTools: ["own"] });
  assert.equal(older.rows.length, 2);
  assert.equal(older.more, false);
  const q = queryDb(db);
  const newest = Math.max(...(await q.all(q.k.selectFrom("main.workspace_calls").select("id"))).map((r) => Number(r.id)));
  assert.equal((await loadWorkspaceCalls(db, ids[0]!, { limit: 10, after: newest - 1, ownTools: ["own"] })).rows.length, 1);

  const inputs = await loadCacheReport(db, ["a", "b"], { hiddenRepos: ["b"], staff: false });
  assert.equal(inputs.kubeEnvs.length, 1);
  assert.equal(inputs.stored, null);
});

test("loadCacheReport and loadWorkspaceCalls: statements do not grow with the number of repos and calls", async () => {
  await expectFlat(async (n) => {
    const { db, close } = await fresh();
    await seedEnv(db);
    const [w] = await requestWorkspaces(db, [req("a")], AT);
    for (let i = 0; i < n; i++) await addCall(db, w!, "shell", { state: "done" });
    const repos = Array.from({ length: n }, (_, i) => `r${i}`);
    return { db, close, run: async () => { await loadCacheReport(db, repos, SCOPE); await loadWorkspaceCalls(db, w!, { limit: 5, ownTools: [] }); } };
  }, 2, 12);
});

both("workspace calls: a claim takes only the live lease's queued calls, refusal needs no lease, stuck and image rows settle by their rules", async ({ db }) => {
  await seedEnv(db);
  const [w] = await requestWorkspaces(db, [req("a")], AT);
  const q = queryDb(db);
  const remote = async (state: string, runId: number, since: number) => Number((await q.get(q.k.insertInto("main.remote_calls").values({
    step: "s", stage: 0, prompt_id: "p", prompt_version: "1", tier: "mid", effort: "medium", asked_model: "m", bundle: "{}", state, since, seen_at: since, max_attempts: 1, timeout_ms: 1000, run_id: runId,
  }).returning("id")))!.id);
  const since = Date.parse(LATER);
  const leased = await remote("leased", 7, since), ended = await remote("done", 8, since);
  const [mine, old, other] = await addWorkspaceCalls(db, [
    { workspace_id: w!, tool: "shell", args: '{"cmd":"ls"}', state: "queued", created_at: LATER, run_id: 7, n: null, result: null, started_at: null, deadline_at: null, finished_at: null },
    { workspace_id: w!, tool: "seed", args: "{}", state: "done", created_at: AT, run_id: 7, n: null, result: null, started_at: null, deadline_at: null, finished_at: null },
    { workspace_id: w!, tool: "shell", args: "{}", state: "queued", created_at: LATER, run_id: 8, n: null, result: null, started_at: null, deadline_at: null, finished_at: null },
  ]);
  assert.deepEqual(await claimQueuedCalls(db, w!, ended), [], "a call with no live lease claims nothing");
  assert.deepEqual(await claimQueuedCalls(db, w!, leased), [{ id: mine, tool: "shell", args: '{"cmd":"ls"}' }]);
  assert.deepEqual((await loadRunningCalls(db, w!, leased)).map((r) => r.id), [mine]);
  assert.deepEqual(await refuseQueuedCalls(db, w!, ended, '{"text":"over"}'), [other]);
  assert.equal((await loadCallResult(db, other!, w!))!.state, "failed");
  assert.equal(await loadCallResult(db, other!, w! + 1), null);

  const since1 = await loadWorkspaceCallSince(db, w!, leased, ["seed"]);
  assert.equal(since1.firstWorkAt, LATER, "the own tool and calls before the call was queued are left out");
  assert.equal(since1.stats.length, 2);

  assert.deepEqual([...await markCalls(db, [{ id: mine!, where: ["running"], set: { n: 3, deadline_at: AT } }, { id: other!, where: ["running"], set: { n: 4 } }])], [mine]);
  assert.equal(await failStuckCalls(db, LATER), 1);
  assert.equal((await loadToolCalls(db, w!, { tool: "shell", n: 3 }))[0]!.state, "failed");

  const image = { text: "", images: [{ data: Buffer.from("png").toString("base64"), mimeType: "image/png" }] };
  const [shot] = await addWorkspaceCalls(db, [{ workspace_id: w!, tool: "screenshot", args: "{}", state: "done", created_at: LATER, run_id: 7, n: null, result: JSON.stringify(image), started_at: null, deadline_at: null, finished_at: null }]);
  assert.equal(await countKeptImages(db, w!, 7, shot! + 1), 1);
  assert.equal(await countKeptImages(db, w!, null, shot! + 1), 0);
  assert.equal(await stubImages(db, [{ id: shot!, stored: "not what is stored", stubbed: "{}" }]), 0, "compare-and-set on the stored result");
  assert.deepEqual(await pruneWorkspaceImageBatch(db, Date.parse(LATER) + IMAGE_KEEP_MS * 2, 0), { rows: 0, last: 0 }, "the workspace has not ended");
  await q.run(q.k.updateTable("main.workspaces").set({ ended_at: LATER }).where("id", "=", w!));
  assert.deepEqual(await pruneWorkspaceImageBatch(db, Date.parse(LATER) + IMAGE_KEEP_MS * 2, 0), { rows: 1, last: shot });
  assert.equal(await countKeptImages(db, w!, 7, shot! + 1), 0);
  const stub = JSON.parse((await loadCallResult(db, shot!))!.result!) as { images: { bytes: number; sha256: string }[] };
  assert.equal(stub.images[0]!.bytes, 3);
});
