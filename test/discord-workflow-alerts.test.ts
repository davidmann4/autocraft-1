// Workflow alerts by direct message: who gets a text when a workflow waits for an answer (its starter and approver, never for a row only
// the automatic merge rule started), each recommendation once, and the hourly limit.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { Alerts, installAlertCommands, type DmRest } from "../src/discord/alerts.ts";
import { installAccountCommands } from "../src/discord/commands.ts";
import { Interactions } from "../src/discord/interactions.ts";
import { DiscordKeys } from "../src/discord/keys.ts";
import { createLinkCode, redeemLinkCode } from "../src/discord/links.ts";
import type { EditBody, MessageBody } from "../src/discord/rest.ts";
import { connectDb } from "./helpers/raw-db.ts";
import { SCRATCH } from "./scratch.ts";
import { RULE_STARTER } from "../src/workflow/types.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "discord-wf-alerts-"));
const db = await connectDb(join(dir, "d.db"));
after(async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); });

class FakeRest implements DmRest {
  sent: { channelId: string; body: MessageBody }[] = [];
  responses: string[] = [];
  async createDm(userId: string) { return { id: `dm-${userId}` }; }
  refuse = (_channelId: string): void => {};
  async createMessage(channelId: string, body: MessageBody) { this.refuse(channelId); this.sent.push({ channelId, body }); return { id: `m${this.sent.length}` }; }
  async editMessage() {}
  async deleteMessage() {}
  async interactionCallback() {}
  async editInteractionResponse(_a: string, _t: string, body: EditBody) { this.responses.push(body.content ?? ""); }
  async overwriteGuildCommands() {}
}

test("a workflow waiting for an answer reaches its starter and approver while they may answer, once, within the hourly limit; a rule row reaches nobody", async () => {
  const now = Date.now(), old = new Date(now - 30 * 3_600_000).toISOString(), at = new Date(now).toISOString();
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", added_by: "op", added_at: old, pipeline: 1 }));
  await db.run(db.k.insertInto("repos").values({ name: "app", visibility: "public" }));
  for (const n of [2, 3, 4, 5]) await db.run(db.k.insertInto("items").values({ repo: "app", number: n, kind: "pr", state: "OPEN", title: `PR ${n}`, body: "", author: "x", head_oid: "sha", created_at: old, updated_at: old, labels: "[]" }));
  for (const [login, role] of [["op", "operator"], ["mia", "maintainer"], ["vi", "viewer"]]) await db.run(db.k.insertInto("access").values({ login, role }));
  await db.run(db.k.insertInto("settings").values({ key: "github_identity", value: "app" }));
  await db.run(db.k.insertInto("repo_permissions").values({ login: "mia", repo: "app", permission: "write", checked_at: at }));

  const keys = new DiscordKeys("k".repeat(40));
  const rest = new FakeRest();
  const alerts = new Alerts({ db, keys, rest, log: () => {}, baseUrl: "https://ac.example", perHour: 2 });
  const ix = new Interactions(rest, () => {});
  installAccountCommands(ix, { db, keys });
  installAlertCommands(ix, alerts);
  const alertsOn = async (userId: string): Promise<string> => {
    const before = rest.responses.length;
    ix.dispatch("INTERACTION_CREATE", { id: "i", token: "t", type: 2, application_id: "a1", user: { id: userId }, data: { name: "autocraft", options: [{ type: 1, name: "account", options: [{ type: 3, name: "action", value: "alerts" }, { type: 3, name: "state", value: "on" }] }] } });
    for (let i = 0; i < 200 && rest.responses.length === before; i++) await new Promise((r) => setTimeout(r, 5));
    return rest.responses.at(-1) ?? "";
  };
  for (const [login, id] of [["op", "1"], ["mia", "2"], ["vi", "3"]]) await redeemLinkCode(db, keys, (await createLinkCode(db, keys, login!)).code, id!);
  assert.match(await alertsOn("3"), /may not answer/);
  assert.match(await alertsOn("1"), /Alerts are on/);
  assert.match(await alertsOn("2"), /Alerts are on/);

  const rec = JSON.stringify({ text: "Merge it.", parts: { fix: [], drop: [] }, merges: true });
  const workflow = (n: number, by: string, approvedBy: string | null = null) => db.run(db.k.insertInto("item_workflows").values({
    repo: "app", number: n, kind: "pr", entry: "review", state: "recommending", started_by: by, approved_by: approvedBy, started_at: at, started_via: "cli", blocker: null, rec, rec_at: new Date(Date.now() + 1000).toISOString(), updated_at: at,
  }));
  await workflow(2, "op", "mia");
  await workflow(5, RULE_STARTER);
  await alerts.sync();
  assert.deepEqual(rest.sent.map((m) => m.channelId).sort(), ["dm-1", "dm-2"], "the starter and the approver; the viewer gets none");
  assert.ok(rest.sent.every((m) => /app#2/.test(m.body.content ?? "")), "the rule row asks nobody");
  assert.match(rest.sent[0]!.body.content ?? "", /https:\/\/ac\.example\/items\/app\/2/);

  await alerts.sync();
  assert.equal(rest.sent.length, 2, "a recommendation is sent once");

  await workflow(3, "op");
  await workflow(4, "op");
  await alerts.sync();
  assert.equal(rest.sent.filter((m) => m.channelId === "dm-1").length, 2, "the hourly limit holds the third message back");
  assert.equal(rest.sent.filter((m) => m.channelId === "dm-2").length, 1, "a maintainer who neither started nor approved an item is not asked");

  // A pass that stops half-way has recorded what it sent: the next one does not send it again.
  await db.run(db.k.deleteFrom("discord_alert_msgs"));
  await db.run(db.k.deleteFrom("item_workflows").where("number", "in", [3, 4]));
  rest.sent.length = 0;
  let died = false;
  const interrupted = new Alerts({ db, keys, rest, log: () => { if (!died) { died = true; throw new Error("the process ends here"); } }, baseUrl: "https://ac.example", perHour: 2 });
  rest.refuse = () => { if (rest.sent.length) throw new Error("lost"); };
  await interrupted.sync().catch(() => {});
  assert.equal(died, true);
  rest.refuse = () => {};
  await alerts.sync();
  assert.deepEqual(rest.sent.map((m) => m.channelId).sort(), ["dm-1", "dm-2"], "each person got it once");
});
