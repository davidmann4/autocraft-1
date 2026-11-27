// Worker for test/thread-call.test.ts: holds its thread for `ms`, then answers with `ms`.
import { serveCalls } from "../../src/thread-call.ts";

serveCalls<{ ms: number }, number>(({ ms }) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  return ms;
});
