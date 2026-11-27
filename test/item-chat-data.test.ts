// The chat of an item: what came before it is backfilled once, and the workflow save path writes AutoCraft's recommendation each time
// an item comes back with a new one, to the people who started or approved it (nobody for a rule row), and its end line.
import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { loadConversationsOfItem, loadMessages, loadMineRefs, type ChatMessageRow } from "../src/data/chat/index.ts";
import { saveWorkflows, startWorkflows } from "../src/data/workflow/index.ts";
import { chatBackfill } from "../src/db/chat-backfill.ts";
import type { Db } from "../src/db/index.ts";
import { connectDb } from "../src/db/open.ts";
import { queryDb as q } from "../src/db/query-db.ts";
import { RULE_STARTER, type Recommendation } from "../src/workflow/types.ts";
import { tmpdir } from "./world-db.ts";

let db: Db | undefined;
afterEach(async () => db?.close());

const AT = "2026-11-20T10:00:00Z";
const rec = (text: string): Recommendation => ({ text, parts: { fix: [], drop: [] }, merges: true });

async function chat(d: Db, number: number): Promise<ChatMessageRow[]> {
  const convs = await loadConversationsOfItem(d, "app", number);
  return [...(await loadMessages(d, convs.map((c) => c.id))).values()].flat();
}

test("the backfill turns earlier commands, messages and an open recommendation into the chat, and a second run adds nothing", async () => {
  const d = db = await connectDb(join(tmpdir("chat"), "t.db"));
  const [wf] = [...(await startWorkflows(d, [{ repo: "app", number: 1, kind: "pr", entry: "review", weight: 5, startedBy: "mira", startedVia: "dashboard", at: AT }])).values()];
  // Rows written before the chat existed, around the save path.
  await q(d).run(q(d).k.updateTable("main.item_workflows").set({ state: "recommending", rec: JSON.stringify(rec("Merge it.")), rec_at: AT }).where("id", "=", wf!));
  const command = JSON.stringify({ kind: "commands", items: [], parts: [{ word: "merge" }] });
  await q(d).run(q(d).k.insertInto("main.workflow_events").values([
    { workflow_id: wf!, repo: "app", number: 1, login: "mira", via: "discord", kind: "started", parsed: command, line: "ok", at: AT },
    { workflow_id: wf!, repo: "app", number: 1, login: "mira", via: "discord", kind: "approved", parsed: command, line: "ok", at: AT },
  ]));
  // As intake and the mirror write them: the command keeps the database id and a parsed time, the mirror the node id and GitHub's time.
  await q(d).run(q(d).k.insertInto("main.github_commands").values({ comment_id: 55, repo: "app", number: 1, pr: 1, command: "answer", login: "olu", github_id: 9, created_at: new Date(AT).toISOString(), requested_at: AT, state: "done", parsed: command }));
  const node = (id: number): string => `IC_${Buffer.from([0x93, 0x00, 0xce, 0x12, 0x34, 0x56, 0x78, id]).toString("base64url")}`;
  await q(d).run(q(d).k.insertInto("main.comments").values([
    { repo: "app", number: 1, id: node(54), kind: "comment", author: "olu", created_at: AT, body: "@app hold" },
    { repo: "app", number: 1, id: node(55), kind: "comment", author: "olu", created_at: AT, body: "@app merge please" },
  ]));
  await q(d).run(q(d).k.insertInto("main.conversation_turns").values({ repo: "app", number: 1, kind: "maintainer", login: "olu", at: AT, body: "Why the hold?", block: "b", status: "answered", seq: 1 }));

  await chatBackfill(d);
  const once = await chat(d, 1);
  const said = once.filter((m) => m.kind === "said").map((m) => [m.via, m.body]).sort();
  assert.deepEqual(said, [["dashboard", "Why the hold?"], ["discord", "merge"], ["github", "@app merge please"]], "one message per command, the comment's own words where they are kept");
  const asked = once.find((m) => m.kind === "recommended");
  assert.equal(asked?.body, "Merge it.");
  assert.deepEqual((asked?.payload as { asked: string[] }).asked, ["mira"]);
  const turns = await q(d).prepare("SELECT conversation_id FROM conversation_turns").all() as { conversation_id: unknown }[];
  assert.ok(turns.length && turns.every((t) => Number(t.conversation_id) === once[0]!.conversationId), "the turn names the item's conversation");

  await chatBackfill(d);
  assert.equal((await chat(d, 1)).length, once.length);
});

test("a save writes a recommendation once per new question, to nobody for a rule row, and the end line once", async () => {
  const d = db = await connectDb(join(tmpdir("chat"), "t.db"));
  const ids = await startWorkflows(d, [
    { repo: "app", number: 2, kind: "pr", entry: "review", weight: 5, startedBy: "mira", startedVia: "dashboard", approvedBy: "olu", approvedVia: "github", at: AT },
    { repo: "app", number: 3, kind: "pr", entry: "review", weight: 5, startedBy: RULE_STARTER, startedVia: "cli", at: AT },
  ]);
  const mine = ids.get("app#2")!, rule = ids.get("app#3")!;
  const ask = (at: string, text = "Merge it.") => ({ state: "recommending" as const, rec: rec(text), recAt: at });
  await saveWorkflows(d, [{ id: mine, patch: ask("2026-11-20T11:00:00Z") }, { id: rule, patch: ask("2026-11-20T11:00:00Z") }]);
  await saveWorkflows(d, [{ id: mine, patch: ask("2026-11-20T11:00:00Z") }]);
  assert.equal((await chat(d, 2)).length, 1, "the same question saved again is no new message");
  await saveWorkflows(d, [{ id: mine, patch: ask("2026-11-20T12:00:00Z", "Fix 1, then merge.") }]);
  await saveWorkflows(d, [{ id: mine, patch: { state: "done", rec: null } }]);
  await saveWorkflows(d, [{ id: mine, patch: { state: "done" } }]);

  const two = await chat(d, 2);
  assert.deepEqual(two.map((m) => m.kind), ["recommended", "recommended", "finished"]);
  assert.deepEqual((two[0]!.payload as { asked: string[] }).asked, ["mira", "olu"]);
  const three = await chat(d, 3);
  assert.equal(three.length, 1);
  assert.deepEqual((three[0]!.payload as { asked: string[] }).asked, [], "a rule row asks nobody");
  assert.equal((await loadConversationsOfItem(d, "app", 2))[0]!.title, "Review");
  await q(d).run(q(d).k.insertInto("main.items").values([2, 3].map((number) => ({ repo: "app", number, kind: "pr", state: "OPEN" }))));
  assert.deepEqual(await loadMineRefs(d, "olu", { doneDays: 7 }), ["app#2"], "the rule's own row is nobody's");
});
