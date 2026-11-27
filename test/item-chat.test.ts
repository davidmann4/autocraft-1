import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { insertRun, finishRun } from "../src/agents/runs.ts";
import { listCommand } from "../src/dash/api/commands.ts";
import { itemChat, postChat, postChatWithdraw } from "../src/dash/api/item-chat.ts";
import { DiscordKeys } from "../src/discord/keys.ts";
import type { Req } from "../src/dash/types.ts";
import type { ChatEntry, ItemChat } from "../web/src/api/types.ts";
import { connectDb, type Db } from "./helpers/raw-db.ts";
import { SCRATCH } from "./scratch.ts";

const SECRET = "s".repeat(40);
mkdirSync(SCRATCH, { recursive: true });
const keyFile = join(mkdtempSync(join(SCRATCH, "chat-")), "key");
writeFileSync(keyFile, SECRET);
chmodSync(keyFile, 0o600);
process.env.AUTOCRAFT_DISCORD_KEY_FILE = keyFile;

const req = (role: "operator" | "viewer", query: Record<string, string> = {}): Req => ({
  method: "GET", path: "", params: { repo: "photocraft", n: "7" }, query: new URLSearchParams(query), form: new URLSearchParams(),
  user: { login: role === "operator" ? "op" : "guest", role, canWrite: async () => role === "operator", canRead: async () => true }, csrf: "", nonce: "",
});
const read = async (db: Db, role: "operator" | "viewer" = "operator") => (await itemChat(db, req(role))) as ItemChat;
const at = (h: number, m = 0, s = 0) => `2026-01-01T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.000Z`;

async function seed(): Promise<Db> {
  const db = await connectDb(":memory:");
  const k = db.k as any;
  await db.run(db.k.insertInto("items").values({ repo: "photocraft", number: 7, kind: "pr", state: "OPEN", author: "dev", created_at: at(0), head_oid: "a".repeat(40) }));
  await db.run(db.k.insertInto("settings").values({ key: "pipeline_login", value: "bot" }));
  const comment = (id: string, author: string, h: number, m: number, body: string) =>
    db.run(db.k.insertInto("comments").values({ repo: "photocraft", number: 7, id, kind: "comment", author, created_at: at(h, m), body, commit_oid: null }));
  await comment("IC_kwABZQ", "maint", 1, 0, "@autocraft review");
  await comment("c4", "bot", 2, 30, "AutoCraft's status comment");
  await comment("c2", "kiri", 3, 0, "Nice catch on the zoom case.");
  await comment("c3", "dev", 3, 10, "Thanks, fixes are welcome.");

  const rec = { text: "The fix is right, but one problem is left.", parts: { fix: [1], drop: [] }, merges: true };
  const plan = [{ n: 1, title: "Handles snap past the edge when zoomed out.", source: "review", file: "src/crop.rs:142", major: false, state: "planned" }];
  await db.run(db.k.insertInto("item_workflows").values({
    repo: "photocraft", number: 7, kind: "pr", entry: "review", state: "recommending", started_by: "maint", started_at: at(1, 0, 5), started_via: "github",
    rec: JSON.stringify(rec), rec_at: at(2, 20), plan: JSON.stringify(plan), updated_at: at(2, 20),
  }));
  await db.run(db.k.insertInto("workflow_events").values([
    { workflow_id: 1, repo: "photocraft", number: 7, login: "maint", via: "github", kind: "started", line: "Reviewing photocraft#7, then I'll come back with the result.", at: at(1, 0, 5) },
    { workflow_id: 1, repo: "photocraft", number: 7, login: "op", via: "dashboard", kind: "weighted", line: "Weight set to high.", at: at(4, 0, 1) },
  ]));

  const run = await insertRun(db, { jobId: null, step: "opus-review", stage: 5, promptId: "review.opus", promptVersion: "1", provider: "claude", model: "opus", items: [{ repo: "photocraft", number: 7 }], prompt: "p" });
  await db.run(db.k.updateTable("agent_runs").set({ started_at: at(1, 30) }));
  await finishRun(db, run, { state: "done", output: "o", costUsd: 0.4 });
  await db.run(db.k.insertInto("opus_review_history").values({ repo: "photocraft", number: 7, head_oid: "a".repeat(40), at: at(2), model: "opus", mode: "full", verdict: "take", sure: 1, reason: "one fix" }));
  await db.run(db.k.insertInto("audit").values({ at: at(2, 10), login: "bot", action: "review-post", target: "photocraft#7", details: JSON.stringify({ head: "a".repeat(40), state: "done", text: "review text" }) }));

  await db.run(k.insertInto("chat_conversations").values({ repo: "photocraft", number: 7, is_main: 1, title: "Review", created_at: at(1), created_by: "maint" }));
  await db.run(k.insertInto("chat_messages").values([
    { conversation_id: 1, author: "maint", via: "github", kind: "said", body: "@autocraft review", payload: JSON.stringify({ url: "https://github.com/x/photocraft/pull/7#issuecomment-101" }), workflow_event_id: 1, turn_id: null, github_comment_id: 101, at: at(1) },
    { conversation_id: 1, author: "autocraft", via: "autocraft", kind: "recommended", body: rec.text, payload: JSON.stringify({ workflowId: 1, rec, parts: plan }), workflow_event_id: null, turn_id: null, at: at(2, 20) },
    { conversation_id: 1, author: "op", via: "dashboard", kind: "said", body: "weight high", payload: null, workflow_event_id: 2, turn_id: null, at: at(4) },
  ]));

  const keys = new DiscordKeys(SECRET);
  await db.run(db.k.insertInto("discord_channels").values({ channel_id: "ch1", guild_id: "g1", guild_name: "Guild", name: "dev", watched: 1 }));
  const mention = (id: string, sealed: string | null, h: number, m: number) => {
    const msgHash = keys.hash("message", id);
    return { msg_hash: msgHash, channel_hash: keys.hash("channel", "ch1"), repo: "photocraft", number: 7, signal: 0,
      sealed: sealed ?? keys.seal({ guildId: "g1", channelId: "ch1", messageId: id, at: at(h, m) }, msgHash) };
  };
  await db.run(db.k.insertInto("discord_mentions").values([mention("m1", null, 3, 20), mention("m2", null, 3, 25), mention("m3", "not-sealed-with-this-key", 3, 22)]));
  return db;
}

const kinds = (es: ChatEntry[]) => es.map((e) => e.t);

test("the chat tells an item as bubbles, replies, work and folded GitHub and Discord lines; a viewer of a quiet PR gets who and when only", async () => {
  const db = await seed();
  const chat = await read(db);
  const [conv] = chat.conversations;
  assert.equal(chat.conversations.length, 1);
  const es = conv!.entries;
  assert.deepEqual(kinds(es), ["github", "said", "reply", "work", "work", "reply", "github", "discord", "said", "reply"]);

  const said = es.filter((e) => e.t === "said");
  assert.deepEqual(said.map((e) => [e.login, e.via, e.body]), [["maint", "github", "@autocraft review"], ["op", "dashboard", "weight high"]]);
  const replies = es.filter((e) => e.t === "reply");
  assert.equal(replies[0]!.body, "Reviewing photocraft#7, then I'll come back with the result.", "the confirmation follows the command it answers");
  assert.equal(replies[2]!.body, "Weight set to high.");
  const recommendation = replies[1]!;
  assert.deepEqual(recommendation.findings.map((f) => f.n), [1]);
  assert.deepEqual(recommendation.ask?.to, ["maint"], "the question goes to who started the work");
  assert.deepEqual(conv!.open?.to, ["maint"]);

  const work = es.filter((e) => e.t === "work");
  assert.equal(work.filter((e) => e.eventId?.startsWith("review:")).length, 1, "the review is shown once");
  assert.ok(!work.some((e) => e.eventId?.startsWith("run:")), "its model call is inside the review, not a row of its own");

  const github = es.filter((e) => e.t === "github");
  const folded = github[1]!;
  assert.equal(folded.count, 2, "the two plain comments fold into one line");
  assert.ok(folded.lines.some((l) => l.includes("Nice catch")) && folded.lines.some((l) => l.includes("Thanks")));
  assert.ok(!JSON.stringify(github).includes("status comment"), "AutoCraft's own comments are not GitHub activity");
  assert.ok(!JSON.stringify(github).includes("@autocraft review"), "a command comment is a bubble, not GitHub activity");

  const discord = es.find((e) => e.t === "discord");
  assert.equal(discord?.t === "discord" && discord.links.length, 2, "two mentions close together collapse into one line; a row the key cannot open is left out");
  assert.ok(discord?.t === "discord" && discord.links.every((l) => l.channel === "dev" && l.url.startsWith("https://discord.com/channels/g1/ch1/")));
  assert.equal(conv!.canReply, true);
  assert.equal(chat.state, "waiting");
  assert.match(chat.next ?? "", /fix 1.*merge/, "while it waits for an answer, next is what a yes runs");

  assert.deepEqual(await itemChat(db, req("operator", { since: chat.stamp })), { unchanged: true, stamp: chat.stamp });
  await db.run((db.k as any).insertInto("chat_messages").values({ conversation_id: 1, author: "op", via: "dashboard", kind: "said", body: "looks good", payload: null, workflow_event_id: null, turn_id: null, at: at(5) }));
  assert.notEqual((await itemChat(db, req("operator", { since: chat.stamp }))).stamp, chat.stamp, "a new message changes the stamp");

  await db.run(db.k.insertInto("security_findings").values({ repo: "photocraft", number: 1, scan_id: 1, area: "a", title: "t", severity: "high", urgent: 0, state: "landing", refs: "[]", reach: "r", impact: "i", fingerprint: "f", fix_pr: 7, created_at: at(0), updated_at: at(0) }));
  const veiled = await read(db, "viewer");
  const v = veiled.conversations[0]!;
  assert.equal(v.canReply, false);
  for (const e of v.entries) {
    if (e.t === "said") assert.ok(e.login && e.at && e.body === "", "who and when stay, the words go");
    if (e.t === "reply") assert.ok(e.body === "" && e.findings.length === 0 && (e.ask === null || e.ask.question === ""));
    if (e.t === "work") assert.ok(e.outcome === null && e.costUsd === null && e.detail.length === 0 && e.model === null && e.title === "AutoCraft work", "no model and no title from the prompt or a finding");
  }
  assert.ok(v.entries.some((e) => e.t === "work"), "the work rows stay, without their outcomes");
  assert.ok(!JSON.stringify(v).includes("one problem is left") && !JSON.stringify(v).includes("weight high"));
});

test("a command written in the chat is stored as the person's message, linked to its event, and shown with its reply; a viewer may not write", async () => {
  const db = await seed();
  const k = db.k as any;
  await db.run(k.insertInto("access").values({ login: "op", role: "operator" }));
  await db.run(k.insertInto("settings").values({ key: "github_identity", value: "app" }));
  await db.run(k.insertInto("tracked_repos").values({ name: "photocraft", workflow: "new" }).onConflict((oc: any) => oc.column("name").doUpdateSet({ workflow: "new" })));
  const post = (role: "operator" | "viewer", text: string): Req => ({ ...req(role), json: { conversation: "main", text } });
  await assert.rejects(postChat(db, post("viewer", "weight low")), { status: 403 });

  const { chat, lines } = await postChat(db, post("operator", "weight low"));
  assert.ok(lines.length > 0, "the command answered");
  const stored = await db.all(db.k.selectFrom("chat_messages").select(["id", "body", "via", "workflow_event_id"]).where("body", "=", "weight low"));
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.via, "dashboard");
  assert.ok(stored[0]!.workflow_event_id, "linked to the workflow event the command wrote");

  const entries = chat.conversations[0]!.entries;
  const i = entries.findIndex((e) => e.t === "said" && e.body === "weight low");
  assert.ok(i >= 0, "the bubble is in the chat");
  assert.equal(entries[i + 1]?.t, "reply", "the command's reply follows it");
});

test("a command list is stored only on items its sender may write to: never for a viewer, and not on another owner's repo or an unknown item", async () => {
  const db = await seed();
  const k = db.k as any;
  await db.run(k.insertInto("tracked_repos").values({ name: "photocraft", workflow: "new" }).onConflict((oc: any) => oc.column("name").doUpdateSet({ workflow: "new" })));
  const send = (role: "maintainer" | "viewer", text: string): Req => ({
    ...req("viewer"), method: "POST", params: {}, json: { text },
    user: { login: role === "maintainer" ? "mia" : "guest", role, canWrite: async () => role === "maintainer", canRead: async () => true },
  });
  const said = async (body: string) => await db.all(k.selectFrom("chat_messages as m").innerJoin("chat_conversations as c", "c.id", "m.conversation_id")
    .select(["c.repo", "c.number", "m.payload"]).where("m.body", "=", body)) as { repo: string; number: number; payload: string | null }[];

  await listCommand(db, send("viewer", "hold: photocraft#7"));
  assert.deepEqual(await said("hold: photocraft#7"), [], "a viewer's words are stored nowhere");

  const text = "hold: otherorg/photocraft#7, photocraft#7, photocraft#99";
  const res = await listCommand(db, send("maintainer", text));
  const rows = await said(text);
  assert.deepEqual(rows.map((r) => `${r.repo}#${r.number}`), ["photocraft#7"], "only the tracked item the maintainer may write to");
  assert.equal((await db.all(k.selectFrom("chat_conversations").select("id").where("number", "=", 99))).length, 0, "no conversation for an item AutoCraft never read");
  const mine = res.items.find((o) => o.repo === "photocraft" && o.number === 7);
  assert.ok(mine && mine.outcome !== "run");
  assert.equal((JSON.parse(rows[0]!.payload ?? "{}") as { refusal?: string }).refusal, mine.line, "a refused command keeps its reply on the message");
});

test("a maintainer's message waiting for Opus can be withdrawn from the chat, and then says who withdrew it", async () => {
  const db = await seed();
  const k = db.k as any;
  await db.run(k.insertInto("conversations").values({ repo: "photocraft", number: 7, item_block: "", item_sig: "", created_at: at(5), created_by: "maint" }));
  const turn = await db.get(k.insertInto("conversation_turns").values({ repo: "photocraft", number: 7, kind: "maintainer", login: "maint", at: at(5), body: "Does it clamp?", block: "", status: "pending" }).returning("id")) as { id: number | string };
  await db.run(k.insertInto("chat_messages").values({ conversation_id: 1, author: "maint", via: "dashboard", kind: "said", body: "Does it clamp?", payload: null, workflow_event_id: null, turn_id: Number(turn.id), at: at(5) }));
  const bubble = (c: ItemChat) => c.conversations[0]!.entries.find((e): e is Extract<ChatEntry, { t: "said" }> => e.t === "said" && e.body === "Does it clamp?")!;

  assert.deepEqual([bubble(await read(db)).pending, bubble(await read(db)).canWithdraw], [true, true], "an operator may withdraw it");
  const after = await postChatWithdraw(db, { ...req("operator"), json: {} });
  assert.ok(!bubble(after).pending && !bubble(after).canWithdraw);
  assert.equal(bubble(after).withdrawnBy, "op");
  assert.equal(bubble(after).refusal, undefined, "a withdrawal is no refusal");
});
