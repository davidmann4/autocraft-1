// Discord linking tokens and the public status layer.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { DiscordKeys } from "../src/discord/keys.ts";
import { CODE_TTL_MS, createLinkCode, forgetLink, loginOf, redeemLinkCode } from "../src/discord/links.ts";
import { publicStats, publicStatus } from "../src/public/status.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { cols } from "../src/db/kx.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "discord-links-"));
const db = await connectDb(join(dir, "d.db"));
const keys = new DiscordKeys("k".repeat(40));
after(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("link codes", () => {
  test("a code links the redeemer to the login it was made for, once; it expires; forgetting removes the link", async () => {
    const { code } = await createLinkCode(db, keys, "mira");
    assert.match(code, /^[A-Z2-9]{8}$/);
    assert.equal(await loginOf(db, keys, "1234"), null);
    assert.equal(await redeemLinkCode(db, keys, "nope1234", "1234"), null);
    assert.equal(await redeemLinkCode(db, keys, code.toLowerCase(), "1234"), "mira");
    assert.equal(await loginOf(db, keys, "1234"), "mira");
    assert.equal(await redeemLinkCode(db, keys, code, "5678"), null, "single use");
    assert.equal(await loginOf(db, keys, "5678"), null);
    // A new code replaces the login's unused one; an expired code links nothing.
    const first = (await createLinkCode(db, keys, "tomas")).code;
    const second = (await createLinkCode(db, keys, "tomas")).code;
    assert.equal(await redeemLinkCode(db, keys, first, "77"), null);
    assert.equal(await redeemLinkCode(db, keys, second, "77", Date.now() + CODE_TTL_MS + 1000), null);
    assert.equal(await loginOf(db, keys, "77"), null);
    const stored = JSON.stringify([await db.all(db.k.selectFrom("discord_links").select(cols("discord_links"))), await db.all(db.k.selectFrom("discord_link_codes").select(cols("discord_link_codes")))]);
    assert.ok(!stored.includes("1234") && !stored.includes(code) && !stored.includes(second), "neither the Discord user id nor a code is stored");
    assert.equal(await forgetLink(db, keys, "1234"), 1);
    assert.equal(await loginOf(db, keys, "1234"), null);
  });
});

describe("public status", async () => {
  const item = (repo: string, number: number, title: string, url: string) => db.run(db.k.insertInto("items").values({ repo, number, kind: "pr", state: "OPEN", title, url, created_at: "2026-11-01T00:00:00Z", labels: "[]" }));
  const plan = (repo: string, number: number, state: string, view: string) => db.run(db.k.insertInto("item_plans").values({ repo, number, kind: "pr", state, actions: "[]", reasons: "[]", view, planned_at: "x" }));
  await db.run(db.k.insertInto("repos").values([{ name: "openrepo", visibility: "PUBLIC" }, { name: "secret", visibility: "PRIVATE" }]));
  await db.run(db.k.insertInto("tracked_repos").values([{ name: "openrepo" }, { name: "secret" }]));
  const queued = JSON.stringify({ gh: "OPEN", queue: {} });
  await item("openrepo", 1, "First", "https://github.com/o/openrepo/pull/1");
  await item("openrepo", 2, "Second", "https://github.com/o/openrepo/pull/2");
  await item("openrepo", 3, "Fix", "https://github.com/o/openrepo/pull/3");
  await item("secret", 1, "Hidden", "https://github.com/o/secret/pull/1");
  await plan("openrepo", 1, "ready", queued);
  await plan("openrepo", 2, "ready", queued);
  await plan("openrepo", 3, "ready", queued);
  await plan("secret", 1, "ready", queued);
  await db.run(db.k.insertInto("item_rank").values([{ repo: "openrepo", number: 2, score: 90, breakdown: "{}", computed_at: "x" }, { repo: "openrepo", number: 1, score: 10, breakdown: "{}", computed_at: "x" }]));
  await db.run(db.k.insertInto("security_findings").values({ repo: "openrepo", number: 1, scan_id: 1, area: "a", title: "t", severity: "high", state: "landing", refs: "[]", reach: "r", impact: "i", fingerprint: "f", created_at: "x", updated_at: "x", fix_pr: 3 }));

  test("queue position follows rank; security-fix PRs and private repos are hidden", async () => {
    const s = (await publicStatus(db, "openrepo", 1))!;
    assert.equal(s.step, "In the merge queue");
    assert.deepEqual(s.queue, { position: 2, of: 2 });
    assert.deepEqual((await publicStatus(db, "openrepo", 2))!.queue, { position: 1, of: 2 });
    assert.equal(await publicStatus(db, "openrepo", 3), null);
    assert.equal(await publicStatus(db, "secret", 1), null);
    assert.equal(await publicStatus(db, "openrepo", 99), null);
    assert.equal(await publicStats(db, "secret"), null);
    const st = (await publicStats(db))!;
    assert.equal(st.queueLength, 2);
    assert.equal(st.openPrs, 2);
    // The Queue page's order: a PR with a started workflow goes first whatever its rank.
    await db.run(db.k.insertInto("item_workflows").values({ repo: "openrepo", number: 1, kind: "pr", entry: "merge", weight: 8, state: "running", started_by: "x", started_at: "2026-11-01T00:00:00Z", started_via: "test", updated_at: "2026-11-01T00:00:00Z" }));
    assert.deepEqual((await publicStatus(db, "openrepo", 1))!.queue, { position: 1, of: 2 });
  });
});
