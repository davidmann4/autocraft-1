import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "usage-reads-"));
const helper = await import("../worker/autocraft.mjs");

const body = { five_hour: { utilization: 20, resets_at: new Date(Date.now() + 3600_000).toISOString() }, seven_day: { utilization: 20, resets_at: new Date(Date.now() + 86400_000).toISOString() } };
const adapter = { id: "claude", token: () => "t" } as any;
const read = (models = ["opus"]) => helper.readQuota({} as any, adapter, "claude", models);
const file = join(process.env.XDG_CACHE_HOME!, "autocraft-runner", "usage.json");
/** Moves the cached reading and the last ask `ms` into the past. */
const age = (ms: number) => {
  const cache = JSON.parse(readFileSync(file, "utf8"));
  cache.reading = { ...cache.reading, at: cache.reading.at - ms };
  if (cache.good) cache.good = { ...cache.good, at: cache.good.at - ms };
  if (cache.askedAt) cache.askedAt -= ms;
  writeFileSync(file, JSON.stringify(cache));
};

test("parallel usage reads make one fetch, and a 429 keeps the last good reading counting", async () => {
  const real = globalThis.fetch;
  let calls = 0;
  let status = 200;
  globalThis.fetch = (async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return status === 429 ? new Response("", { status, headers: { "retry-after": "120" } }) : new Response(JSON.stringify(body), { status });
  }) as any;
  try {
    const [a, b, c] = await Promise.all([read(), read(), read()]);
    assert.equal(calls, 1);
    assert.equal(a, b);
    assert.ok(!("error" in c));
    // The provider now refuses; the cached good reading is replaced by a refusal that Retry-After holds back.
    age(helper.CLAUDE_ASK_EVERY_MS + 1000);
    status = 429;
    const failed = await read();
    assert.equal(calls, 2);
    assert.ok(!("error" in failed) && failed.lastGood, "the last good reading stands in, marked");
    assert.deepEqual(helper.quotaVerdict(failed, { fiveHour: 20, weekly: 20 }), { ok: true });
    assert.equal((helper.quotaVerdict(failed, { fiveHour: 80 - helper.LAST_GOOD_MARGIN + 1, weekly: 20 }) as any).ok, false, "too close to the reserve holds");
    await read();
    assert.equal(calls, 2, "Retry-After keeps the next fetch away");
  } finally {
    globalThis.fetch = real;
  }
});

test("the Claude usage endpoint is asked at most once per interval, and new models keep the good reading and the provider's wait", async () => {
  rmSync(file, { force: true });
  const real = globalThis.fetch;
  let calls = 0;
  let status = 200;
  globalThis.fetch = (async () => {
    calls++;
    return status === 429 ? new Response("", { status, headers: { "retry-after": "300" } }) : new Response(JSON.stringify(body), { status });
  }) as any;
  try {
    await read();
    assert.equal(calls, 1);
    age(helper.CLAUDE_ASK_EVERY_MS / 2);
    assert.ok(!("error" in await read()), "the reading is reused within the interval");
    // A config or helper update changes the models: the cached reply is read again for them, without asking.
    const other = await read(["opus", "sonnet"]);
    assert.equal(calls, 1);
    assert.ok(!("error" in other) && other.lastGood === undefined);
    age(helper.CLAUDE_ASK_EVERY_MS);
    status = 429;
    assert.ok(!("error" in await read(["opus", "sonnet"])));
    assert.equal(calls, 2);
    const back = await read();
    assert.equal(calls, 2, "the provider's wait holds for the old models too");
    assert.ok(!("error" in back) && back.lastGood, "the last good reading stands in");
  } finally {
    globalThis.fetch = real;
  }
});
