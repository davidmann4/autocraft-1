import assert from "node:assert/strict";
import { test } from "node:test";
import { ThreadCall } from "../src/thread-call.ts";

test("a call past its timeout fails clearly, and the stopped worker never fails the calls of the worker that replaces it", async () => {
  const t = new ThreadCall<{ ms: number }, number>(new URL("./helpers/thread-worker.ts", import.meta.url), "test", undefined, { timeoutMs: 1000 });
  try {
    await assert.rejects(t.call({ ms: 5000 }), /test call got no reply within/);
    // The stuck worker exits while this call waits on its replacement.
    assert.equal(await t.call({ ms: 300 }), 300);
  } finally {
    await t.close();
  }
});
