// Results in a Discord thread: a result too long for one message is summarized with its recommendation line kept word for word, an
// item of a private repo shows only its status line and link, a second pass posts nothing again, and a deleted result message is
// posted anew while a deleted thread stops being followed.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { saveWorkflows, startWorkflows } from "../src/data/workflow/index.ts";
import { DiscordKeys } from "../src/discord/keys.ts";
import { RestError, UNKNOWN_CHANNEL, UNKNOWN_MESSAGE, type EditBody, type MessageBody } from "../src/discord/rest.ts";
import type { ResultAsk } from "../src/discord/result-ask.ts";
import { RESULT_MAX, ThreadResults } from "../src/discord/results.ts";
import { follow, followOf, threadTarget } from "../src/discord/threads.ts";
import { recommendationLine } from "../src/workflow/status.ts";
import type { PlanPart, Recommendation } from "../src/workflow/types.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "discord-results-"));
const db = await connectDb(join(dir, "d.db"));
const keys = new DiscordKeys("k".repeat(40));
after(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

const sent: { channelId: string; body: MessageBody }[] = [];
/** Channels whose sends fail, and message ids whose edits fail, with Discord's error code. */
const sendFails = new Map<string, number>(), editFails = new Map<string, number>();
const edited: string[] = [];
const rest = {
  async createMessage(channelId: string, body: MessageBody) {
    const code = sendFails.get(channelId);
    if (code) throw new RestError(404, "gone", code);
    sent.push({ channelId, body });
    return { id: `r${sent.length}` };
  },
  async editMessage(_channelId: string, messageId: string, _body: EditBody) {
    const code = editFails.get(messageId);
    if (code) throw new RestError(404, "gone", code);
    edited.push(messageId);
  },
};
const asks: ResultAsk[] = [];
const logs: string[] = [];
const results = new ThreadResults({
  db, keys, rest, log: (l) => logs.push(l),
  summarize: async (_db, a) => { asks.push(a); return [{ parts: [1, 2], text: "The export path drops the quality setting." }]; },
});

const SECRET = "the private repo's finding";
const plan = (title: string): PlanPart[] => Array.from({ length: 30 }, (_, i) => ({ n: i + 1, title: `${title} ${i + 1}: ${"x".repeat(80)}`, source: "review", state: "planned" }));
let ids = new Map<string, number>();
const rec: Recommendation = { text: "Fix 1 and 2, then merge.", parts: { fix: [1, 2], drop: [] }, merges: true };

before(async () => {
  await db.run(db.k.insertInto("tracked_repos").values([{ name: "photocraft" }, { name: "vault" }]).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("repos").values([
    { name: "photocraft", owner: "storytold", visibility: "public" }, { name: "vault", owner: "storytold", visibility: "private" },
  ]).onConflict((oc) => oc.doNothing()));
  for (const repo of ["photocraft", "vault"]) {
    await db.run(db.k.insertInto("items").values({ repo, number: 7, kind: "pr", state: "OPEN", title: "Fix 7", body: "", url: `https://github.com/storytold/${repo}/pull/7` }));
  }
  ids = await startWorkflows(db, ["photocraft", "vault"].map((repo) => ({ repo, number: 7, kind: "pr" as const, entry: "review" as const, weight: 5, startedBy: "nora", startedVia: "discord" as const })));
  const at = new Date().toISOString();
  await saveWorkflows(db, [
    { id: ids.get("photocraft#7")!, patch: { state: "recommending", rec, recAt: at, plan: plan("Finding") } },
    { id: ids.get("vault#7")!, patch: { state: "recommending", rec, recAt: at, plan: plan(SECRET) } },
  ]);
  for (const repo of ["photocraft", "vault"]) {
    const thread = `t-${repo}`;
    await follow(db, keys, { targetHash: threadTarget(keys, thread), channelHash: keys.hash("channel", "c1"), target: { kind: "thread", guildId: "g1", channelId: thread, messageId: "m1" },
      author: keys.hash("author", "u70"), items: [{ repo, number: 7 }], command: "review", login: "nora", at });
  }
});

test("a long result is summarized with its recommendation word for word; a private repo's thread gets only the status line and link", async () => {
  await results.sync();
  const pub = sent.filter((s) => s.channelId === "t-photocraft");
  assert.equal(pub.length, 1);
  const text = pub[0]!.body.content!;
  assert.ok(text.length <= RESULT_MAX);
  assert.ok(text.includes(recommendationLine(rec)!));
  assert.match(text, /The export path drops the quality setting/);
  assert.equal(asks.length, 1);
  assert.deepEqual(pub[0]!.body.allowed_mentions, { parse: [] });

  const priv = sent.filter((s) => s.channelId === "t-vault");
  assert.equal(priv.length, 1);
  assert.ok(!priv[0]!.body.content!.includes(SECRET));
  assert.ok(!priv[0]!.body.content!.includes("Recommendation"));
  assert.match(JSON.stringify(priv[0]!.body.components), /github\.com\/storytold\/vault\/pull\/7/);

  // Nothing changed: nothing is posted again and no model call is made.
  await results.sync();
  assert.equal(sent.length, 2);
  assert.equal(asks.length, 1);
  assert.deepEqual(logs, []);
});

test("a result message deleted in Discord is posted anew and the thread still follows; a deleted thread stops being followed", async () => {
  const before = sent.length;
  // The public result changes while its message is gone: the edit finds no message (10008), so a new one is posted.
  editFails.set("r1", UNKNOWN_MESSAGE);
  const fewer = plan("Finding").slice(0, 3);
  await saveWorkflows(db, [{ id: ids.get("photocraft#7")!, patch: { plan: fewer } }]);
  // The private item moves on while its thread is gone (10003).
  sendFails.set("t-vault", UNKNOWN_CHANNEL);
  await saveWorkflows(db, [{ id: ids.get("vault#7")!, patch: { state: "running", rec: null } }]);
  await results.sync();

  const reposted = sent.slice(before).filter((s) => s.channelId === "t-photocraft");
  assert.equal(reposted.length, 1);
  assert.match(reposted[0]!.body.content!, /Finding 3/);
  assert.ok(await followOf(db, keys, threadTarget(keys, "t-photocraft")));
  assert.equal(await followOf(db, keys, threadTarget(keys, "t-vault")), null);

  // The new message is the one a later change edits.
  editFails.clear();
  await saveWorkflows(db, [{ id: ids.get("photocraft#7")!, patch: { plan: fewer.slice(0, 2) } }]);
  await results.sync();
  assert.equal(edited.at(-1), `r${before + 1}`);
});
