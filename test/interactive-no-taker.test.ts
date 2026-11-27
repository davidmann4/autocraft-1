// The interactive-no-taker health check: Discord calls need an operator's ready Task Runner with an Interactive slot.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { computeChecks } from "../src/health-checks.ts";
import { parseStatus, storeStatus } from "../src/remote/helpers.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });

test("warns when no ready runner has an interactive slot, ok when one does or Discord is off", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "interactive-no-taker-")), "t.db"));
  await db.run(db.k.insertInto("access").values({ login: "olga", role: "operator" }));
  const now = Date.now();
  const token = (await createToken(db, "olga", "helper", { kind: "runner" })).row.id;
  const status = (readiness: string) => parseStatus({ slots: 1, busy: 0, readiness, ...(readiness === "quota-held" && { until: new Date(now + 3600_000).toISOString() }), harness: "claude", models: { top: "opus", small: "haiku" }, reserve: { fiveHour: 0, weekly: 0 } });
  const check = async () => (await computeChecks(db, now)).find((c) => c.id === "interactive-no-taker")!;
  const saved = process.env.AUTOCRAFT_DISCORD_KEY_FILE;
  try {
    delete process.env.AUTOCRAFT_DISCORD_KEY_FILE;
    await storeStatus(db, token, "olga", status("quota-held"), now);
    assert.equal((await check()).state, "ok", "Discord off");

    process.env.AUTOCRAFT_DISCORD_KEY_FILE = "/x";
    const held = await check();
    assert.equal(held.state, "warn");
    assert.match(held.text, /holding for its reserve until/);
    assert.doesNotMatch(held.text, /olga/);

    await storeStatus(db, token, "olga", status("ready"), now);
    assert.equal((await check()).state, "ok");
  } finally {
    if (saved === undefined) delete process.env.AUTOCRAFT_DISCORD_KEY_FILE; else process.env.AUTOCRAFT_DISCORD_KEY_FILE = saved;
  }
});
