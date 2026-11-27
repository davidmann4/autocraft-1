// The helper routes use their own connection with a short busy timeout: while another process holds SQLite's write lock,
// a helper request answers 503 with Retry-After instead of holding the dashboard's event loop.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { addLogin } from "../src/access.ts";
import { apiRoutes } from "../src/dash/api/index.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { loadConfig } from "../src/dash/server/config.ts";
import { startServer } from "../src/dash/server/index.ts";
import { FakeProvider } from "../src/dash/server/provider.ts";
import { RateLimiter } from "../src/dash/server/util.ts";
import { ROUTES } from "../src/remote/protocol.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "../src/db/open.ts";
import { sqliteOnly } from "./test-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "remote-busy-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("a helper route answers 503 with Retry-After while the database is locked, and 200 once it is free", { skip: sqliteOnly("SQLite's write lock and busy timeout; Postgres takes row locks and has no database-wide write lock") }, async () => {
  const file = join(dir, "t.db"), perms = join(dir, "perms.json");
  writeFileSync(perms, "{}");
  const db = await connectDb(file), remoteDb = await connectDb(file, { busyTimeoutMs: 100 }), other = await connectDb(file);
  await addLogin(db, "cli", "bob", "maintainer", null);
  const { token } = await createToken(db, "bob", "helper", { kind: "runner" });
  const config = loadConfig({ AUTOCRAFT_DEV_AUTH: "1", AUTOCRAFT_LISTEN: "127.0.0.1:0", AUTOCRAFT_DB: file, AUTOCRAFT_DEV_PERMS: perms });
  const limiter = new RateLimiter(60, 3600_000);
  const s = await startServer({ config, db, remoteDb, provider: new FakeProvider(perms), routes: apiRoutes() });
  try {
    const status = () => fetch(`${s.url}${ROUTES.status}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 20, weekly: 20 }, slots: 1, busy: 0 }),
    });
    assert.equal((await status()).status, 200);
    await other.write(async () => {
    const started = Date.now();
    const r = await status();
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("retry-after"), "5");
    assert.ok(Date.now() - started < 5_000, "answered after the short busy timeout");
    });
    assert.equal((await status()).status, 200);
  } finally {
    await s.close();
    for (const c of [other, remoteDb, db]) await c.close();
  }
});
