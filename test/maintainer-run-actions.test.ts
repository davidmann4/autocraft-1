// Per-repo and per-item actions are for whoever runs the repo (operator, or maintainer with GitHub write); instance-wide ones stay with operators.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connectDb } from "./helpers/raw-db.ts";
import { reviewItemAgain } from "../src/dash/api/operator.ts";
import { batchRemovePr } from "../src/dash/api/queue-page.ts";
import { release, releaseAll } from "../src/dash/api/outside.ts";
import { edit } from "../src/dash/api/areas.ts";

const t = "2026-11-01T00:00:00.000Z";
const as = (role: string, writable: string[], params: Record<string, string> = {}, json?: unknown) => ({
  method: "POST", path: "", params, query: new URLSearchParams(), form: new URLSearchParams(), csrf: "", nonce: "", json,
  user: { login: "u1", role, canWrite: async (r: string) => writable.includes(r), canRead: async () => true },
}) as never;

async function world() {
  const db = await connectDb(":memory:");
  await db.run(db.k.insertInto("repos").values({ name: "app", visibility: "public" }));
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: t, pipeline: 1 }));
  await db.run(db.k.insertInto("items").values({ repo: "app", number: 1, kind: "pr", state: "OPEN", title: "PR", head_oid: "h1", updated_at: t }));
  await db.run(db.k.insertInto("opus_reviews").values({ repo: "app", number: 1, head_oid: "h1", at: t, mode: "full", verdict: "hold", reason: "needs work" }));
  return db;
}

test("a maintainer with write runs one action per area; without write, or as a viewer, every one is refused", async () => {
  const db = await world();
  const item = { repo: "app", n: "1" };
  const actions: [string, (req: never) => Promise<unknown>, Record<string, string>, unknown?][] = [
    ["review again", (r) => reviewItemAgain(db, r), item],
    ["remove from batch", (r) => batchRemovePr(db, r), {}, { item: "app#1" }],
    ["release outside", (r) => release(db, r), item],
    ["area edit", (r) => edit(db, r), { repo: "app" }, { op: "add", name: "Canvas", description: "drawing" }],
  ];
  for (const [what, run, params, json] of actions) {
    await assert.rejects(run(as("maintainer", [], params, json)), { status: 403 }, `${what}: maintainer without write`);
    await assert.rejects(run(as("viewer", ["app"], params, json)), { status: 403 }, `${what}: viewer`);
  }
  for (const [what, run, params, json] of actions) {
    await assert.doesNotReject(run(as("maintainer", ["app"], params, json)).catch((e: { status?: number }) => { if (e.status === 403) throw e; }), `${what}: maintainer with write`);
  }
  assert.equal((await db.all(db.k.selectFrom("opus_reviews").select("head_oid"))).length, 0);
});

test("release-all of outside authors stays with operators", async () => {
  const db = await world();
  await assert.rejects(releaseAll(db, as("maintainer", ["app"], {}, { author: "x" })), { status: 403 });
});
