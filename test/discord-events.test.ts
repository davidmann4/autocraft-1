// The Discord usage counters: an event lands in the 24-hour and 7-day counts by its age, old rows are pruned, and a failing write never throws.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { eventCounts, recordEvent } from "../src/discord/events.ts";
import { connectDb } from "../src/db/open.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "discord-events-"));
const db = await connectDb(join(dir, "d.db"));
after(async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); });

test("events are counted by age and pruned after 8 days", async () => {
  const now = Date.parse("2026-11-23T12:00:00Z"), h = 3_600_000;
  await recordEvent(db, "started", undefined, now - 30 * h);
  await recordEvent(db, "started", undefined, now - 2 * h);
  await recordEvent(db, "filed", undefined, now - 5 * 24 * h);
  await recordEvent(db, "junk", undefined, now - 9 * 24 * h);
  await recordEvent(db, "limits", undefined, now);
  const c = await eventCounts(db, now);
  assert.deepEqual(c.started, { day: 1, week: 2 });
  assert.deepEqual(c.filed, { day: 0, week: 1 });
  assert.deepEqual(c.limits, { day: 1, week: 1 });
  assert.deepEqual(c.junk, { day: 0, week: 0 });
  assert.equal(Number((await db.get(db.k.selectFrom("discord_events").select((eb) => eb.fn.countAll<number>().as("n")).where("kind", "=", "junk")))!.n), 0, "the 9-day-old row was pruned by the next write");

  await db.run(db.k.deleteFrom("discord_events"));
  await db.close();
  const lines: string[] = [];
  await recordEvent(db, "started", (m) => lines.push(m), now);
  assert.equal(lines.length, 1, "a failed write is logged, not thrown");
});
