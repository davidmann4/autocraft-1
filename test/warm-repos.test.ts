// The warm producer builds only repos in the warm_repos allowlist (and in the pipeline scope).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createEnv } from "../src/build/envs.ts";
import { parseSettings } from "../src/build/pods.ts";
import { changeWarmRepos, warmPass, warmRepos } from "../src/build/warm-queue.ts";
import { runCollect } from "../src/verify/results.ts";
import { connectDb } from "./helpers/raw-db.ts";

test("warmPass queues only repos that are in scope and in the allowlist", async () => {
  const d = await connectDb(":memory:");
  await d.script("INSERT INTO tracked_repos (name, pipeline) VALUES ('app', 1), ('other', 1), ('off', 0); INSERT INTO repos (name, visibility) VALUES ('app', 'public'), ('other', 'public'), ('off', 'public')");
  const warm = parseSettings({
    namespace: "craft-warm", image: "autocraft:test", toolchainImages: { "rust-stable": "rust-stable:test" }, warmWriter: true, crateMirror: "10.43.250.25",
    sccacheUrl: "http://cache.test:8080", cacheWriteUrl: "http://cache.test:8081", writerSecret: "writer", signingSecret: "signing",
  });
  await createEnv(d, { id: "warm", label: "Warm", kind: "kubernetes", slots: 1, settings: warm }, "op");
  const at = "2026-01-01T00:00:00Z";
  for (const repo of ["app", "other", "off"]) await d.run(d.k.insertInto("main_ci").values({
    repo, head_sha: "a".repeat(40), branch: "main", state: "green", failing: "[]", checks: "[]", committed_at: at, headline: null, first_seen_at: at, state_changed_at: at, updated_at: at,
  }));
  assert.equal(await warmPass(d), 0, "an empty allowlist builds nothing");
  await changeWarmRepos(d, "add", "other", "op");
  await changeWarmRepos(d, "add", "off", "op");
  assert.deepEqual(await warmRepos(d), ["off", "other"]);
  assert.equal(await warmPass(d), 1, "only the allowed repo that is in scope");
  const queued = await d.all(d.k.selectFrom("build_tasks").select("repo"));
  assert.deepEqual(queued.map((r) => r.repo), ["other"]);
  await changeWarmRepos(d, "remove", "other", "op");
  assert.deepEqual(await warmRepos(d), ["off"]);
});

test("a queued warm build is cancelled on a main-CI reading made after it was queued, not on an older one", async () => {
  const d = await connectDb(":memory:");
  const head = (sha: string, at: string) => d.run(d.k.insertInto("main_ci").values({
    repo: "app", head_sha: sha.repeat(40), branch: "main", state: "green", failing: "[]", checks: "[]", committed_at: at, headline: null, first_seen_at: at, state_changed_at: at, updated_at: at,
  }));
  await head("a", "2026-01-01T00:00:00Z");
  await d.run(d.k.insertInto("build_tasks").values({ step: "verify", repo: "app", head_sha: "b".repeat(40), requires: "{}", plan: "[]", state: "queued", queued_at: "2026-01-01T00:01:00Z", warm_key: "app", warm_role: "build" }));
  const cancelled = async () => (await runCollect(d, {}, () => {})).warmCancelled;
  assert.equal(await cancelled(), 0, "the poll had not seen its head yet");
  await head("b", "2026-01-01T00:02:00Z");
  assert.equal(await cancelled(), 0);
  await head("c", "2026-01-01T00:04:00Z");
  assert.equal(await cancelled(), 1, "the branch moved on");
});
