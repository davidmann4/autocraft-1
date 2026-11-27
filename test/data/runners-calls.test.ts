// The runners module's call lifecycle: statement counts of the hot paths (queue, claim, poll) and the lease's compare-and-set. Each case runs on SQLite,
// and on Postgres when AUTOCRAFT_TEST_PG_URL names a server.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db, Dialect } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import { expectFlat } from "../helpers/query-count.ts";
import { TEST_PG_URL, testDatabase, type TestDatabase } from "../test-db.ts";
import { enqueueCalls, setCallLevels, withdrawCalls, withdrawGoneCalls, withdrawItemCalls } from "../../src/data/runners/calls-queue.ts";
import { loadCallPolls, loadCalls, loadLeaseTurnover, loadRemoteQueueStates } from "../../src/data/runners/calls-read.ts";
import { expireLeases, loadLeaseState } from "../../src/data/runners/calls-expiry.ts";
import { discardGoneLease, failLease, releaseLease, submitLease } from "../../src/data/runners/calls-submit.ts";
import { ITEM_WITHDRAWN_PREFIX } from "../../src/data/runners/calls-shared.ts";
import { applyLocal } from "../../src/data/mirror/local.ts";
import { heartbeatLease, loadLiveLease } from "../../src/data/runners/cross.ts";
import { loadClaimFacts, loadLeaseSource } from "../../src/data/runners/calls-claim.ts";
import { loadQueueFor } from "../../src/data/runners/calls-queue-load.ts";
import { leaseCall } from "../../src/data/runners/calls-lease.ts";
import type { LeaseRequest, NewCall } from "../../src/data/runners/types.ts";
import { packPrompt } from "../../src/data/inference/types.ts";

const dialects: Dialect[] = TEST_PG_URL ? ["sqlite", "postgres"] : ["sqlite"];
const NOW = 1_700_000_000_000;

const call = (n: number, over: Partial<NewCall> = {}): NewCall => ({
  promptId: "classify.sonnet", promptVersion: "1", tier: "mid", effort: "medium", askedModel: "m", level: 0, maxAttempts: 2,
  bundle: { stdin: "x", timeoutSeconds: 60, mcpServers: [], hints: {} } as unknown as NewCall["bundle"],
  items: [{ repo: "app", number: n }], job: { jobId: null, step: "classify", stage: 0, cls: 0, repo: "app" }, ...over,
});

async function fresh(dialect: Dialect): Promise<{ t: TestDatabase; db: Db }> {
  const t = await testDatabase("", dialect);
  return { t, db: await t.open({ app: true }) };
}

/** Runner credentials: `n` logins, each a maintainer with one live token. */
async function runners(db: Db, n: number): Promise<{ tokenId: number; login: string }[]> {
  const q = queryDb(db);
  const out: { tokenId: number; login: string }[] = [];
  for (let i = 1; i <= n; i++) {
    const login = `user${i}`;
    await q.run(q.k.insertInto("main.access").values({ login, role: "maintainer" }).onConflict((oc) => oc.doNothing()));
    const r = await q.get(q.k.insertInto("main.mcp_tokens").values({ login, token_hash: `h${i}`, created_at: "2026-01-01T00:00:00Z", expires_at: "2099-01-01T00:00:00Z", kind: "runner", can_agent: 1 }).returning("id"));
    out.push({ tokenId: Number(r!.id), login });
  }
  return out;
}


for (const dialect of dialects) {
  test(`enqueue writes one row per item set-based and keeps the item table equal to the items (${dialect})`, async () => {
    const { t, db } = await fresh(dialect);
    try {
      await expectFlat(async (size) => {
        const x = await fresh(dialect);
        return { db: x.db, run: () => enqueueCalls(x.db, Array.from({ length: size }, (_, i) => call(i + 1, { items: [{ repo: "app", number: i + 1 }, { repo: "lib", number: i + 1 }] })), NOW), close: () => x.t.close() };
      }, 1, 12);
      const ids = await enqueueCalls(db, [call(1), call(2, { items: [{ repo: "app", number: 2 }, { repo: "lib", number: 9 }] })], NOW);
      const q = queryDb(db);
      const rows = await q.all(q.k.selectFrom("main.remote_call_items").select(["call_id", "pos", "repo", "number"]).orderBy("call_id").orderBy("pos"));
      assert.deepEqual(rows.filter((r) => r.call_id === ids[1]).map((r) => `${r.repo}#${r.number}`), ["app#2", "lib#9"]);
      assert.equal(await withdrawItemCalls(db, "app#1", "gone"), 1, "a call whose only item is app#1 is withdrawn");
      assert.equal(await withdrawItemCalls(db, "app#2", "gone"), 0, "a call with two items is not");
    } finally { await t.close(); }
  });

  test(`the caller poll reads every waiting call in a fixed number of statements (${dialect})`, async () => {
    await expectFlat(async (size) => {
      const x = await fresh(dialect);
      const ids = await enqueueCalls(x.db, Array.from({ length: size }, (_, i) => call(i + 1)), NOW);
      return { db: x.db, run: async () => assert.equal((await loadCallPolls(x.db, ids, NOW)).size, size), close: () => x.t.close() };
    }, 1, 8);
  });

  test(`a claim reads its facts and the queue in a fixed number of statements (${dialect})`, async () => {
    const claim = async (queued: number, runnerCount: number) => {
      const x = await fresh(dialect);
      const rs = await runners(x.db, runnerCount);
      await enqueueCalls(x.db, Array.from({ length: queued }, (_, i) => call(i + 1)), NOW);
      return { db: x.db, run: async () => { const f = await loadClaimFacts(x.db, { ...rs[0]!, role: "maintainer" }, { now: NOW, requestId: "r1" }); await loadQueueFor(x.db, NOW, f.signature); }, close: () => x.t.close() };
    };
    await expectFlat((n) => claim(n, 1), 2, 10);
    await expectFlat((n) => claim(2, n), 1, 4);
  });

  test(`two claims of one call: exactly one leases it, and a login at its cap is refused (${dialect})`, async () => {
    const { t, db } = await fresh(dialect);
    try {
      const [a, b] = await runners(db, 2);
      const [id, other] = await enqueueCalls(db, [call(1), call(2)], NOW);
      const source = (await loadLeaseSource(db, id!))!;
      const req = (who: { tokenId: number; login: string }, callId: number, over: Partial<LeaseRequest> = {}): LeaseRequest => ({
        id: callId, caller: { ...who, role: "maintainer" }, claim: { harness: "claude", harnessVersion: "1", requestId: `req-${who.login}` }, model: "m", now: NOW,
        caps: { perLogin: null, interactive: null }, started: false, clearIdle: false, source, prompt: packPrompt("p", (x) => x), rewrite: null, live: () => true, ...over });
      const results = await Promise.all([leaseCall(db, req(a!, id!)), leaseCall(db, req(b!, id!))]);
      assert.equal(results.filter((r) => typeof r === "object" && r !== null).length, 1, "one lease");
      assert.equal(results.filter((r) => r === null).length, 1, "the other claim found the call taken");
      const winner = results.findIndex((r) => r !== null) === 0 ? a! : b!;
      assert.equal(await leaseCall(db, req(winner, other!, { caps: { perLogin: 1, interactive: null }, source: (await loadLeaseSource(db, other!))! })), "limit");
      const q = queryDb(db);
      const rows = await q.all(q.k.selectFrom("main.remote_calls").select(["id", "state", "user_login"]).orderBy("id"));
      assert.deepEqual(rows.map((r) => r.state), ["leased", "queued"]);
      assert.equal(rows[0]!.user_login, winner.login);
    } finally { await t.close(); }
  });

  test(`a lease runs its life: heartbeat, lost lease back to the queue, failure, release, submit (${dialect})`, async () => {
    const { t, db } = await fresh(dialect);
    try {
      const [a] = await runners(db, 1);
      const ids = await enqueueCalls(db, [call(1), call(2), call(3), call(4)], NOW);
      const lease = async (id: number, at: number) => {
        const r = await leaseCall(db, { id, caller: { ...a!, role: "maintainer" }, claim: { harness: "claude", harnessVersion: "1" }, model: "m", now: at, caps: { perLogin: null, interactive: null }, started: false, clearIdle: false,
          source: (await loadLeaseSource(db, id))!, prompt: packPrompt("p", (x) => x), rewrite: null, live: () => true });
        assert.ok(typeof r === "object" && r !== null);
        return r;
      };
      const l1 = await lease(ids[0]!, NOW);
      const live = (await loadLiveLease(db, l1.secret, NOW + 1000))!;
      assert.equal(live.id, ids[0]);
      assert.deepEqual(await heartbeatLease(db, l1.secret, { progress: "step", phase: "running" }, NOW + 1000), { runId: l1.runId });
      assert.deepEqual(await loadLeaseState(db, l1.secret), { id: ids[0], live: true });
      // No heartbeat for longer than the idle window: the next read ends the lease, and the secret answers as ended.
      const late = NOW + 3 * 60_000;
      assert.equal(await loadLiveLease(db, l1.secret, late), null);
      assert.deepEqual(await loadLeaseState(db, l1.secret), { id: ids[0], live: false });
      const after = (await loadCalls(db, ids)).get(ids[0]!)!;
      assert.equal(after.state, "queued");
      assert.equal(await heartbeatLease(db, l1.secret, { progress: null, phase: null }, late), null, "an ended lease takes no heartbeat");
      assert.deepEqual(await expireLeases(db, { now: late }), { requeued: [], failed: [], withdrawn: [], beaten: [] }, "nothing is lost twice");
      // Failure with an attempt left requeues; release requeues without using one; submit ends it.
      const l2 = await lease(ids[1]!, late);
      const live2 = (await loadLiveLease(db, l2.secret, late))!;
      assert.equal(await failLease(db, live2, { error: "boom", skipLogin: true, usage: null, duration: 0 }, late), true);
      const l3 = await lease(ids[2]!, late);
      assert.equal(await releaseLease(db, (await loadLiveLease(db, l3.secret, late))!, "released", late), true);
      const l4 = await lease(ids[3]!, late);
      const live4 = (await loadLiveLease(db, l4.secret, late))!;
      assert.deepEqual(await submitLease(db, live4, { reply: "r", model: "m", usage: {}, turns: 1, sessionId: null, tools: [], durationMs: 5 }, late), { accepted: true });
      const states = await loadCalls(db, ids);
      assert.deepEqual(ids.map((i) => states.get(i)!.state), ["queued", "queued", "queued", "done"]);
      assert.equal(await submitLease(db, live4, { reply: "again", model: "m", usage: {}, turns: 1, sessionId: null, tools: [], durationMs: 5 }, late).then((r) => r.accepted), false, "a second submit finds the lease gone");
      // Withdraw with a reason per call, levels by item, and the per-job and per-login reads.
      assert.deepEqual((await withdrawCalls(db, [{ id: ids[0]!, reason: "first" }, { id: ids[1]!, reason: "second" }], { states: ["queued"], now: late })).sort(), [ids[0], ids[1]].sort());
      const reasons = await loadCalls(db, [ids[0]!, ids[1]!]);
      assert.equal(reasons.get(ids[0]!)!.error, "first");
      assert.equal(reasons.get(ids[1]!)!.error, "second");
      assert.equal(await setCallLevels(db, [{ ref: "app#3", level: 3 }]), 1);
      const q = queryDb(db);
      assert.equal(Number((await q.get(q.k.selectFrom("main.remote_calls").select("level").where("id", "=", ids[2]!)))!.level), 3);
      assert.deepEqual([...(await loadRemoteQueueStates(db, [1], late)).keys()], []);
      assert.equal((await loadLeaseTurnover(db, ["USER1"])).get("user1"), "0:");
    } finally { await t.close(); }
  });

  test(`a call whose items all merged or closed is withdrawn (at the close or by the sweep), never leased, and a result for it is discarded; a post-merge review still runs (${dialect})`, async () => {
    const { t, db } = await fresh(dialect);
    try {
      const [a] = await runners(db, 1);
      const q = queryDb(db);
      await q.run(q.k.insertInto("main.items").values([1, 2, 3].map((number) => ({ repo: "app", number, kind: "pr", state: "OPEN" }))));
      const postmerge = (n: number) => call(n, { promptId: "postmerge.opus", job: { jobId: null, step: "postmerge", stage: 0, cls: 0, repo: "app" } });
      const [queued, running, review] = await enqueueCalls(db, [call(1), call(2), call(3)], NOW);
      const lease = async (id: number) => await leaseCall(db, { id, caller: { ...a!, role: "maintainer" }, claim: { harness: "claude", harnessVersion: "1" }, model: "m", now: NOW, caps: { perLogin: null, interactive: null },
        started: false, clearIdle: false, source: (await loadLeaseSource(db, id))!, prompt: packPrompt("p", (x) => x), rewrite: null, live: () => true });
      const leased = await lease(running!);
      assert.ok(typeof leased === "object" && leased !== null);
      await applyLocal(db, [{ kind: "state", repo: "app", number: 1, state: "CLOSED" }, { kind: "merged", repo: "app", number: 2, at: "2026-11-27T04:56:00Z" }]);
      const after = await loadCalls(db, [queued!, running!, review!]);
      assert.equal(after.get(queued!)!.state, "failed");
      assert.ok(after.get(queued!)!.error!.startsWith(ITEM_WITHDRAWN_PREFIX), "the job awaiting it skips the item");
      assert.equal(after.get(running!)!.state, "leased", "a running call finishes");
      assert.equal(after.get(review!)!.state, "queued", "a call on an open item stays");
      // The running call's reply comes back after the merge: accepted, and nothing applies it.
      assert.equal(await discardGoneLease(db, (await loadLiveLease(db, leased.secret, NOW))!, { usage: null, duration: 1 }, NOW), true);
      assert.ok((await loadCalls(db, [running!])).get(running!)!.error!.startsWith(ITEM_WITHDRAWN_PREFIX));
      assert.equal(await discardGoneLease(db, (await loadLiveLease(db, (await lease(review!) as { secret: string }).secret, NOW))!, { usage: null, duration: 1 }, NOW), false, "an open item's result is kept");
      // A call queued for a merged item is not leased; its post-merge review is.
      const [late, pm] = await enqueueCalls(db, [call(2, { bundle: { stdin: "y", timeoutSeconds: 60, mcpServers: [], hints: {} } as unknown as NewCall["bundle"] }), postmerge(2)], NOW);
      assert.equal(await lease(late!), null);
      assert.equal((await loadCalls(db, [late!])).get(late!)!.state, "queued", "refused for its item, not taken");
      assert.ok(typeof await lease(pm!) === "object");
      // A call that was queued on an item before it merged, with no close seen since, goes at the maintenance sweep; the post-merge
      // review's own reference check on it, another prompt of that step, stays and is leased.
      const [check] = await enqueueCalls(db, [call(2, { promptId: "lint.reference.haiku", job: { jobId: null, step: "postmerge", stage: 0, cls: 0, repo: "app" } })], NOW);
      assert.deepEqual(await withdrawGoneCalls(db, NOW), [late]);
      assert.ok(typeof await lease(check!) === "object");
    } finally { await t.close(); }
  });
}
