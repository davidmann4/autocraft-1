// workflow module, part a: the leg, request and hold writers whose logic is a compare-and-set or a batched insert with an audit row each
// (SQLite; Postgres when AUTOCRAFT_TEST_PG_URL is set). They write audit rows through control.addAudit.
import assert from "node:assert/strict";
import { queryDb } from "../../src/db/query-db.ts";
import { addFixupRequests, addLegs, endFixupRequests, loadLegs, moveLegs, startWorkflows } from "../../src/data/workflow/index.ts";
import { AT, both } from "./planner-helpers.ts";

const wf = (repo: string, number: number) => ({ repo, number, kind: "pr" as const, entry: "review" as const, weight: 5, startedBy: "ann", startedVia: "cli" as const, at: AT });
const audits = async (db: Parameters<typeof queryDb>[0], action: string) => {
  const q = queryDb(db);
  return (await q.all(q.k.selectFrom("main.audit").select(["target", "details", "login"]).where("action", "=", action).orderBy("target"))).map((r) => ({ ...r, details: JSON.parse(r.details ?? "{}") as Record<string, unknown> }));
};

both("addLegs refuses a PR that has an active leg, in a batch and against stored legs, and audits the legs it made", async ({ db }) => {
  const ids = await startWorkflows(db, [wf("o/a", 1), wf("o/a", 2), wf("o/a", 3)]);
  const leg = (number: number, o: Record<string, unknown> = {}) => ({ repo: "o/a", number, by: "ann", workflowId: ids.get(`o/a#${number}`)!, head: `h${number}`, state: "review" as const, ...o });
  const first = await addLegs(db, [leg(1), leg(2, { state: "fixup", instructions: "x", via: "cli" }), leg(1)]);
  assert.equal(typeof first.get("o/a#1"), "number");
  assert.equal(typeof first.get("o/a#2"), "number");
  const second = await addLegs(db, [leg(2), leg(3)]);
  assert.equal(second.get("o/a#2"), "active", "the partial unique index refuses a second active leg");
  assert.equal(typeof second.get("o/a#3"), "number");
  const legs = await loadLegs(db, [1, 2, 3].map((number) => ({ repo: "o/a", number })));
  assert.equal(legs.get("o/a#1")!.length, 1);
  assert.equal(legs.get("o/a#1")![0]!.head, "h1", "a review leg starts at its head");
  assert.equal(legs.get("o/a#2")![0]!.head, null, "a fix-up leg has no head until its push");
  assert.equal(legs.get("o/a#2")![0]!.from_head, "h2");
  assert.deepEqual((await audits(db, "preapproval")).map((a) => a.target), ["o/a#1", "o/a#2", "o/a#3"]);
});

both("moveLegs moves a leg only from the state the caller saw, ends its linked request and audits what moved", async ({ db }) => {
  const q = queryDb(db);
  const ids = await startWorkflows(db, [wf("o/a", 1), wf("o/a", 2)]);
  const made = await addFixupRequests(db, [{ repo: "o/a", number: 1, fromHead: "h1", instructions: "do it", by: "ann", merge: true, workflowId: ids.get("o/a#1")! }, { repo: "o/a", number: 2, fromHead: "h2", instructions: "plain", by: "ann" }]);
  const withLeg = made.get("o/a#1")!;
  assert.ok(withLeg.legId !== null && made.get("o/a#2")!.legId === null);
  const link = await q.get(q.k.selectFrom("main.operator_fixups").select("preapproval_id").where("id", "=", withLeg.requestId));
  assert.equal(link!.preapproval_id, withLeg.legId, "the request links to its leg");
  const moved = await moveLegs(db, [
    { id: withLeg.legId!, from: "review", to: "ci", head: "pushed" },
    { id: withLeg.legId!, from: "fixup", to: "ci", head: "pushed", by: "bob", reason: "r" },
  ]);
  assert.deepEqual(moved, [], "the leg is in fixup, not review: nothing moves");
  const ok = await moveLegs(db, [{ id: withLeg.legId!, from: "fixup", to: "ci", head: "pushed", by: "bob", via: "cli" }]);
  assert.deepEqual(ok.map((m) => [m.repo, m.number, m.to]), [["o/a", 1, "ci"]]);
  const keep = await moveLegs(db, [{ id: withLeg.legId!, from: "ci", to: "queued" }]);
  assert.equal(keep.length, 1);
  assert.equal((await loadLegs(db, [{ repo: "o/a", number: 1 }])).get("o/a#1")![0]!.head, "pushed", "a move without a head keeps the head");
  assert.equal((await q.get(q.k.selectFrom("main.operator_fixups").select("state").where("id", "=", withLeg.requestId)))!.state, "queued", "a live leg keeps its request");
  await moveLegs(db, [{ id: withLeg.legId!, from: "queued", to: "cancelled", reason: "stopped", by: "ann" }]);
  assert.equal((await q.get(q.k.selectFrom("main.operator_fixups").select("state").where("id", "=", withLeg.requestId)))!.state, "ended", "an ended leg ends its request");
  const trail = (await audits(db, "preapproval")).filter((a) => a.target === "o/a#1");
  assert.deepEqual(trail.map((a) => a.details.state), ["fixup", "ci", "queued", "cancelled"]);
  assert.equal(trail[3]!.details.reason, "stopped");
  assert.equal(trail[1]!.login, "bob");
  assert.equal(trail[2]!.login, "pipeline", "a move with no actor is the pipeline's");
});

both("addFixupRequests writes nothing when a merge request meets an active leg; endFixupRequests ends only queued requests", async ({ db }) => {
  const q = queryDb(db);
  const ids = await startWorkflows(db, [wf("o/a", 1), wf("o/a", 2)]);
  await addLegs(db, [{ repo: "o/a", number: 1, by: "ann", workflowId: ids.get("o/a#1")!, head: "h1", state: "review" }]);
  await assert.rejects(addFixupRequests(db, [{ repo: "o/a", number: 2, fromHead: "h2", instructions: "a", by: "ann" }, { repo: "o/a", number: 1, fromHead: "h1", instructions: "b", by: "ann", merge: true }]), /already has a pre-approved merge/);
  assert.equal((await q.all(q.k.selectFrom("main.operator_fixups").select("id"))).length, 0, "the whole batch rolled back");
  const made = await addFixupRequests(db, [{ repo: "o/a", number: 2, fromHead: "h2", instructions: "a", by: "ann" }, { repo: "o/a", number: 3, fromHead: "h3", instructions: "b", by: "ann" }]);
  const [a, b] = [made.get("o/a#2")!.requestId, made.get("o/a#3")!.requestId];
  assert.deepEqual(await endFixupRequests(db, [{ id: a, reason: "the head moved" }]), [a]);
  assert.deepEqual(await endFixupRequests(db, [{ id: a, reason: "again" }, { id: b, reason: "no longer open" }]), [b], "an ended request does not end twice");
  const ended = (await audits(db, "operator-fixup")).filter((x) => x.details.ended);
  assert.deepEqual(ended.map((x) => x.details.reason).sort(), ["no longer open", "the head moved"]);
});

