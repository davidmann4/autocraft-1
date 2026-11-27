// Implementations run in the one enabled kubernetes environment that is no warm producer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createEnv, updateEnv } from "../src/build/envs.ts";
import { implementEnv } from "../src/implement/workspace.ts";
import { connectDb } from "./helpers/raw-db.ts";

test("a warm producer beside the build pods is not an environment for implementations", async () => {
  const db = await connectDb(":memory:");
  const pods = { image: "autocraft:test", toolchainImages: { "rust-stable": "rust-stable:test" } };
  await createEnv(db, { id: "pods", label: "Pods", kind: "kubernetes", slots: 2, settings: pods }, "op");
  await createEnv(db, { id: "warm", label: "Warm", kind: "kubernetes", slots: 2, settings: { ...pods, namespace: "warm", warmWriter: true, sccacheUrl: "http://cache.test", cacheWriteUrl: "https://cache.test", writerSecret: "writer", signingSecret: "signing" } }, "op");
  assert.equal(await implementEnv(db), "pods");
  await createEnv(db, { id: "more", label: "More", kind: "kubernetes", slots: 2, settings: { ...pods, namespace: "more" } }, "op");
  await assert.rejects(implementEnv(db), /exactly one/);
  await updateEnv(db, "pods", { enabled: false }, "op");
  await updateEnv(db, "more", { enabled: false }, "op");
  await assert.rejects(implementEnv(db), /no kubernetes environment/);
  await db.close();
});
