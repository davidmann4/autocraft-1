// A workspace that did not start before the plan call is AutoCraft's to retry, not a person's decision: the attempt waits on a
// backoff and is planned again, and only the failure after the retries asks a maintainer. One that got stuck after a model call
// still asks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { implementStep } from "../src/core/decide-item.ts";
import { loadItemFact } from "../src/core/issue-facts.ts";
import type { ItemFacts } from "../src/core/plan.ts";
import { startFailed } from "../src/implement/plan.ts";
import { IMPLEMENT_START_RETRIES } from "../src/implement/start-retry.ts";
import { markStuck } from "../src/implement/stuck.ts";
import { currentImplementation, roundsOf, setImplementationState, startImplementation } from "./implement-rows.ts";
import { OPERATOR, world } from "./world-db.ts";

const ENV_ERROR = "2 kubernetes environments are enabled; implementations need exactly one";

test("a failed workspace start retries on a backoff without asking; after the retries, or after a model call, a maintainer is asked", async () => {
  const w = await (await (await (await world()).repo()).issue(7)).issue(9);
  const db = w.db;
  // Facts as a queued issue in scope sees them, at `ms`.
  const step = async (n: number, ms?: number) => {
    const f = (await loadItemFact(db, "app", n))!;
    const queued: ItemFacts = { ...f, inScope: true, now: ms ?? f.now, implement: { ...f.implement, queuedBy: OPERATOR, standing: "yes", featureOn: true } };
    return implementStep(queued);
  };
  const waitWho = (s: Awaited<ReturnType<typeof step>>) => (s && "wait" in s ? s.wait.who : null);

  const impl = await startImplementation(db, { repo: "app", number: 7, queuedBy: OPERATOR, textHash: "h" });
  await startFailed(db, impl, ENV_ERROR);
  assert.equal((await currentImplementation(db, "app", 7))?.state, "planning");
  assert.ok(!(await roundsOf(db, impl.id)).some((r) => r.kind === "question"), "nothing is asked");
  assert.equal(waitWho(await step(7)), "system", "the retry waits on its backoff");
  assert.deepEqual(await step(7, Date.now() + 24 * 3600_000), { bucket: "plan" }, "after the backoff the plan runs again");

  for (let i = 1; i < IMPLEMENT_START_RETRIES; i++) await startFailed(db, impl, ENV_ERROR);
  assert.equal((await currentImplementation(db, "app", 7))?.state, "planning", "still retried within the bound");
  await startFailed(db, impl, ENV_ERROR);
  assert.equal((await currentImplementation(db, "app", 7))?.state, "stuck", "the failure after the retries is stuck");
  assert.equal(waitWho(await step(7, Date.now() + 24 * 3600_000)), "person", "and asks a maintainer, also later");

  // A workspace lost after the plan call ran keeps asking.
  const built = await startImplementation(db, { repo: "app", number: 9, queuedBy: OPERATOR, textHash: "h" });
  await setImplementationState(db, built.id, "implementing", { planCallId: 41 });
  await markStuck(db, (await currentImplementation(db, "app", 9))!, "workspace-lost", "workspace 4 is failed");
  assert.equal(waitWho(await step(9)), "person");
});
