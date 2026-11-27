// A PR the GitHub App's bot opened counts as ours once its slug is known, whatever the repo's identity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPrFacts } from "../src/core/facts.ts";
import { ownLogins, rememberSlug } from "../src/github/identity.ts";
import { world } from "./world-db.ts";

test("the app's bot is ours on every repo once its slug is known, and stays ours without the secrets", async () => {
  const w = await (await (await (await (await world()).repo()).pr(1, { author: "my-app" })).pr(2, { author: "box" })).pr(3, { author: "stranger" });
  await w.db.run(w.db.k.insertInto("main.settings").values({ key: "pipeline_login", value: "box" }));
  const mine = async () => Object.fromEntries((await loadPrFacts(w.db)).map((f) => [f.number, f.authorIsPipeline]));
  assert.deepEqual([...await ownLogins(w.db, "app", "my-app")].sort(), ["box", "my-app", "my-app[bot]"]);
  assert.deepEqual([...await ownLogins(w.db, "app", null)], ["box"]);

  // A slug seen once stays ours when the secrets can no longer be read, on repos of either identity.
  await rememberSlug(w.db, "my-app");
  assert.deepEqual(await mine(), { 1: true, 2: true, 3: false });
  await w.db.run(w.db.k.insertInto("main.settings").values({ key: "github_identity", value: "app" }));
  assert.deepEqual([...await ownLogins(w.db, "app", null)].sort(), ["box", "my-app", "my-app[bot]"]);
  assert.deepEqual([...await ownLogins(w.db, "other", null)].sort(), ["box", "my-app", "my-app[bot]"]);
  assert.deepEqual(await mine(), { 1: true, 2: true, 3: false });
});
