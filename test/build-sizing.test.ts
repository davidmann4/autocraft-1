// Step pod memory per repository: automatic from measured builds, an OOM kill raises it up to the environment's cap, and
// the step pod carries it, the build priority class and, when the run was placed, the node. The warm target follows the
// published version's size.
import assert from "node:assert/strict";
import { test } from "node:test";
import { connectDb } from "./helpers/raw-db.ts";
import { groupsOf, parseSettings, quantity, stepPod, taskRequest, type Prepared } from "../src/build/pods.ts";
import { createEnv } from "../src/build/envs.ts";
import { raiseAfterOom, repoMemory, repoSizing, repoWarmTarget, setWarmTarget } from "../src/build/sizing.ts";
import { warmKeyOf } from "../src/build/tasks.ts";
import { recordWarmBytes } from "../src/build/warm-queue.ts";
import type { TaskStep } from "../web/src/api/types.ts";

test("OOM kills raise a repo's step memory up to maxPodMemory; its step pod runs with it on the placed node", async () => {
  const db = await connectDb(":memory:");
  const s = parseSettings({ maxPodMemory: "16Gi", toolchainImages: { "rust-stable": "rust-stable:test" } });
  const start = await repoMemory(db, "app", s);
  const first = await raiseAfterOom(db, "app", s);
  assert.ok(first.raised && first.memory.limitBytes > start.limitBytes && first.memory.requestBytes > start.requestBytes);
  let last = first;
  for (let i = 0; i < 5 && last.raised; i++) last = await raiseAfterOom(db, "app", s);
  assert.equal(last.raised, false, "raises stop at the cap");
  assert.ok(last.memory.limitBytes <= quantity(s.maxPodMemory) && last.memory.requestBytes <= last.memory.limitBytes);
  assert.deepEqual(await repoMemory(db, "app", s), last.memory);

  const plan: TaskStep[] = [{ name: "build", cmd: ["cargo", "build"], network: "none", timeoutSec: 600 }];
  const prepared: Prepared = { env: {}, mounts: [], packages: [], craftFontsRef: null, craftI18nRev: null };
  const ctx = { s, envId: "pods", taskId: 1, stage: 2, name: "p", pvc: "v", deadlineSec: 600, memory: last.memory, node: "node-a" };
  const pod = stepPod(ctx, "rust-stable:test", "autocraft:test", plan, groupsOf(plan)[0]!, prepared, false, "app") as { spec: Record<string, any> };
  assert.equal(pod.spec.priorityClassName, s.priorityClassName);
  assert.deepEqual(pod.spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].values, ["node-a"]);
  const step = pod.spec.containers[0];
  assert.equal(quantity(step.resources.limits.memory), last.memory.limitBytes);
  assert.ok(taskRequest(s, last.memory).memBytes >= quantity(step.resources.requests.memory), "the reservation covers the step pod");
  const unplaced = stepPod({ ...ctx, node: null }, "rust-stable:test", "autocraft:test", plan, groupsOf(plan)[0]!, prepared, false, "app") as { spec: Record<string, any> };
  assert.equal(unplaced.spec.affinity, undefined);
  await db.close();
});

test("step memory follows measured builds; an OOM kill raises it for the next build and the raise is kept", async () => {
  const db = await connectDb(":memory:");
  const s = parseSettings({ memoryRequest: "8Gi", memoryLimit: "16Gi", maxPodMemory: "64Gi", toolchainImages: { "rust-stable": "rust-stable:test" } });
  await createEnv(db, { id: "pods", label: "Pods", kind: "kubernetes", slots: 1, settings: s }, "op");
  const at = new Date().toISOString();
  await db.run(db.k.insertInto("main_ci").values({ repo: "app", head_sha: "a".repeat(40), branch: "main", state: "green", failing: "[]", checks: "[]", committed_at: at, headline: null, first_seen_at: at, state_changed_at: at, updated_at: at }));
  const build = async (peak: number) => await db.run(db.k.insertInto("build_tasks").values({
    step: "nightly", repo: "app", head_sha: "a".repeat(40), requires: "{}", plan: JSON.stringify([{ name: "build", cmd: ["cargo", "build"], network: "none", timeoutSec: 600 }]), state: "done", env_id: "pods",
    queued_at: new Date().toISOString(), ended_at: new Date().toISOString(), results: JSON.stringify([{ step: "build", exitCode: 0, durationMs: 5, timedOut: false, peakMemBytes: peak }]),
  }));
  for (const peak of [1.5e9, 2e9, 2.5e9]) await build(peak);
  const auto = await repoMemory(db, "app", s);
  assert.equal((await repoSizing(db, "app")).memorySource, "history");
  assert.ok(auto.limitBytes < quantity(s.memoryLimit) && auto.limitBytes > 2.5e9 && auto.requestBytes >= 1.5e9, "sized from the builds, below the environment's");
  const r = await raiseAfterOom(db, "app", s);
  assert.ok(r.raised);
  const next = await repoMemory(db, "app", s);
  assert.ok(next.limitBytes > auto.limitBytes && next.requestBytes > auto.requestBytes, "the next build gets more");
  assert.equal((await repoSizing(db, "app")).memorySource, "oom", "the raise is kept as a floor under the history size");
  await db.close();
});

test("the warm target is chosen from the published version's size; an operator's choice overrides it", async () => {
  const db = await connectDb(":memory:");
  await recordWarmBytes(db, warmKeyOf("small"), 6.4e9);
  await recordWarmBytes(db, warmKeyOf("large"), 27e9);
  assert.equal(await repoWarmTarget(db, "small"), "tmpfs");
  assert.equal(await repoWarmTarget(db, "large"), "pvc", "a large version goes on the volume");
  assert.equal(await repoWarmTarget(db, "new"), "none", "nothing to start from before a publish");
  await setWarmTarget(db, "large", "none", "op");
  assert.equal(await repoWarmTarget(db, "large"), "none");
  await setWarmTarget(db, "large", "auto", "op");
  assert.equal(await repoWarmTarget(db, "large"), "pvc");
  assert.equal((await db.all(db.k.selectFrom("build_sizes").select("repo"))).length, 0, "an automatic repo keeps no row");
  await db.close();
});
