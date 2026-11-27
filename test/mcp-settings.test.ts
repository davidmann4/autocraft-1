// set_my_settings changes the caller's own settings through the same checks and audit as PUT /api/me/settings; a viewer is refused.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { handleMcp, type McpEnv } from "../src/dash/mcp/index.ts";
import type { Role } from "../src/dash/types.ts";
import { userReserve } from "../src/remote/reserve.ts";
import { RateLimiter } from "../src/dash/server/util.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const db = await connectDb(join(mkdtempSync(join(SCRATCH, "mcp-settings-")), "t.db"));

const env = (login: string, role: Role): McpEnv => ({
  db, baseUrl: null, canAnswer: false, expensive: () => 0,
  user: async () => ({ login, role, canWrite: async () => true, canRead: async () => true }) as never,
});
const call = (e: McpEnv, name: string, args: unknown) => handleMcp(e, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as Promise<{ result: { isError?: boolean; content: { text: string }[] } }>;

test("set_my_settings changes the caller's reserve and audits it; a viewer is refused", async () => {
  const maint = env("mia", "maintainer");
  const r = await call(maint, "set_my_settings", { reserve_five_hour: 35 });
  assert.equal(r.result.isError, undefined);
  assert.deepEqual(await userReserve(db, "mia"), { fiveHour: 35, weekly: (await userReserve(db, "nobody")).weekly });
  assert.equal((await db.get(db.k.selectFrom("audit").select("action").where("action", "=", "usage-reserve")))?.action, "usage-reserve");
  assert.match((await call(maint, "my_settings", {})).result.content[0]!.text, /5-hour 35%/);
  assert.equal((await call(maint, "set_my_settings", { reserve_weekly: 95 })).result.isError, true);
  assert.match((await call(maint, "set_my_settings", { manual_only: true })).result.content[0]!.text, /manual only: on/);
  assert.match((await call(maint, "my_settings", {})).result.content[0]!.text, /manual only: on/);

  const refused = await call(env("vera", "viewer"), "set_my_settings", { reserve_five_hour: 50 });
  assert.equal(refused.result.isError, true);
  assert.equal((await userReserve(db, "vera")).fiveHour, (await userReserve(db, "nobody")).fiveHour);
});
