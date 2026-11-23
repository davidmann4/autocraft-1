// The Discord search and filing flow: /autocraft search opens a form (app select and description), the reply lists
// matches with "None of these", which goes through the follow-up questions to a checked draft with a type select and
// File it / Edit / Open on GitHub; File it shows each result of fileIssue(). The daily cap builds the draft from the
// form alone, and the rate limit refuses.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Embedder } from "../src/embed/model.ts";
import { toBlob } from "../src/embed/store.ts";
import { VectorIndex } from "../src/embed/vectors.ts";
import { Interactions } from "../src/discord/interactions.ts";
import { sanitize } from "../src/discord/issue-draft.ts";
import type { FileResult } from "../src/discord/file-issue.ts";
import { installIssueNew, type IssueAsk } from "../src/discord/issue-new.ts";
import { DiscordKeys } from "../src/discord/keys.ts";
import type { CallbackData, CommandDef, DiscordRest, EditBody, MessageBody } from "../src/discord/rest.ts";
import { Search } from "../src/discord/search.ts";
import { installSearchCommands } from "../src/discord/search-commands.ts";
import { useTestAccount } from "./accounts-fixture.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "../src/db/open.ts";
import { excluded } from "../src/db/kx.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "discord-issue-"));
const db = await connectDb(join(dir, "d.db"));
const keys = new DiscordKeys("k".repeat(40));
await useTestAccount(db);
after(async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); });

const VOCAB = ["webp", "export", "quality", "dark", "mode", "layers"];
const embedder: Embedder = {
  id: "fake", dim: VOCAB.length,
  async embed(texts) {
    return texts.map((t) => {
      const v = new Float32Array(VOCAB.length);
      VOCAB.forEach((w, i) => { if (t.toLowerCase().includes(w)) v[i] = 1; });
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  },
};

class FakeRest implements DiscordRest {
  callbacks: { type: number; data?: CallbackData }[] = [];
  edits: EditBody[] = [];
  async createMessage(_c: string, _b: MessageBody) { return { id: "m" }; }
  async editMessage() {}
  async deleteMessage() {}
  async interactionCallback(_i: string, _t: string, type: 4 | 5 | 6 | 8 | 9, data?: CallbackData) { this.callbacks.push({ type, data }); }
  async editInteractionResponse(_a: string, _t: string, body: EditBody) { this.edits.push(body); }
  async overwriteGuildCommands(_a: string, _g: string, _c: CommandDef[]) {}
}

const rest = new FakeRest();
const ix = new Interactions(rest, (l) => assert.fail(l));
const calls: { id: string; input: unknown }[] = [];
let draftReply: string | null = JSON.stringify({ title: "WebP export ignores quality", body: "Quality has no effect. See https://evil.example/x and https://github.com/storytold/photocraft/issues/1 ping @everyone <@123>" });
let questionsReply: string | null = JSON.stringify({ ask: ["steps", "env", "bogus"] });
const ask = (async (_db: unknown, id: string, input: unknown) => { calls.push({ id, input }); return id === "discord.issue-questions" ? questionsReply : draftReply; }) as IssueAsk;
const search = new Search({ db, embedder, index: new VectorIndex(embedder), log: () => {} });
installSearchCommands(ix, { db, keys, search });
const junkCalls: { title: string; body: string; kind?: string }[] = [];
let junkResult: "junk" | "ok" | "unknown" = "ok";
const filed: { reporter: string; repo: string; title: string; body: string; kind: string; junkChecked?: boolean }[] = [];
let fileResult: FileResult = { status: "refused", reason: "x" };
installIssueNew(ix, { db, keys, search, log: (l) => assert.fail(l), ask, filing: true, junk: async (_d, a) => { junkCalls.push(a); return junkResult; }, file: async (_d, req) => { filed.push(req); return fileResult; } });

let n = 0;
const send = async (type: number, user: string, data: unknown, channel = "c1") => {
  rest.callbacks.length = 0; rest.edits.length = 0;
  ix.dispatch("INTERACTION_CREATE", { id: `i${++n}`, token: "t", type, application_id: "app1", channel_id: channel, member: { user: { id: user } }, data });
  for (let k = 0; k < 50 && !(rest.callbacks.length && (rest.callbacks.at(-1)!.type !== 5 || rest.edits.length)); k++) await new Promise((r) => setTimeout(r, 5));
};
const modalId = (): string => rest.callbacks.find((c) => c.type === 9)!.data!.custom_id!;
const submit = (user: string, custom_id: string, values: Record<string, string>) =>
  send(5, user, { custom_id, components: Object.entries(values).map(([id, value]) => ({ type: 1, components: [{ type: 4, custom_id: id, value }] })) });
/** The search form: Label-wrapped select (values) and text input (value), as Discord sends them. */
const submitForm = (user: string, app: string, description: string) =>
  send(5, user, { custom_id: modalId(), components: [
    { type: 18, component: { type: 3, custom_id: "app", values: [app] } },
    { type: 18, component: { type: 4, custom_id: "description", value: description } },
  ] });
const press = (user: string, custom_id: string) => send(3, user, { custom_id });
const choose = (user: string, custom_id: string, values: string[]) => send(3, user, { custom_id, values });
const searchCmd = (user: string, channel = "c1") => send(2, user, { name: "autocraft", type: 1, options: [{ name: "search", type: 1 }] }, channel);
type Comp = { type: number; label?: string; custom_id?: string; url?: string; content?: string; components?: Comp[]; accessory?: Comp; options?: { value: string; default?: boolean }[] };
// Buttons and selects in order; a result section contributes its accessory button.
const rows = (b: EditBody) => (b.components as Comp[]).flatMap((r) => (r.type === 9 ? [r.accessory!] : r.type === 10 ? [] : r.components!));
const v2text = (b: EditBody) => (b.components as Comp[]).flatMap((c) => (c.type === 9 ? c.components! : [c])).filter((c) => c.type === 10).map((c) => c.content).join("\n");
const NONE = "None of these, file a new one";
/** Presses a button that asks the questions: the model's choice was made at submit, so the form opens as the response. */
const pressToQuestions = async (user: string, id: string) => {
  await press(user, id);
  return rest.callbacks[0]!;
};
const draftUrl = (b: EditBody): URL => new URL(rows(b).find((x) => x.label === "Open on GitHub instead")!.url!);

before(async () => {
  await db.run(db.k.insertInto("tracked_repos").values([{ name: "photocraft" }, { name: "vectorcraft" }, { name: "secret" }]).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("repos").values([{ name: "photocraft", owner: "storytold", visibility: "public" }, { name: "vectorcraft", owner: "storytold", visibility: "public" }, { name: "secret", owner: "storytold", visibility: "private" }])
    .onConflict((oc) => oc.column("name").doUpdateSet(excluded(["visibility"]))));
  await db.run(db.k.insertInto("release_apps").values({ repo: "vectorcraft", name: "Vector Studio", stars: 0, updated_at: "2026-01-01" }));
  await db.run(db.k.insertInto("discord_channels").values({ channel_id: "c1", guild_id: "g1", guild_name: "G", name: "dev", watched: 1, default_repo: "photocraft" }));
  const recent = new Date().toISOString();
  await db.run(db.k.insertInto("items").values({ repo: "photocraft", number: 1, kind: "issue", state: "OPEN", title: "Export to WebP ignores the quality setting", body: "", url: "https://github.com/storytold/photocraft/issues/1" }));
  await db.run(db.k.insertInto("item_embeddings").values({ repo: "photocraft", number: 1, model: "fake", hash: "h", vec: toBlob((await embedder.embed(["Export to WebP ignores the quality setting"], "item"))[0]!), at: recent }));
});

describe("search and filing flow", () => {
  test("/autocraft search answers with the form: app select preselected, description box; the reply lists matches and the None button", async () => {
    await searchCmd("u1");
    assert.equal(rest.callbacks[0]!.type, 9);
    const comps = rest.callbacks[0]!.data!.components as { type: number; label: string; component: { type: number; custom_id: string; options?: { label: string; value: string; default?: boolean }[]; style?: number } }[];
    assert.deepEqual(comps.map((c) => [c.type, c.component.type, c.component.custom_id]), [[18, 3, "app"], [18, 4, "description"]]);
    assert.deepEqual(comps[0]!.component.options, [{ label: "photocraft", value: "photocraft", default: true }, { label: "Vector Studio", value: "vectorcraft" }].sort((a, b) => a.label.localeCompare(b.label)));
    await submitForm("u1", "photocraft", "webp export quality slider does nothing");
    const b = rest.edits[0]!;
    assert.match(v2text(b), /photocraft#1 Export to WebP/);
    // The first reply comes from the embeddings alone, with no reason line; the questions call runs in the background from submit.
    assert.deepEqual(calls.map((c) => c.id), ["discord.issue-questions"]);
    assert.doesNotMatch(v2text(b), />/);
    assert.deepEqual(rows(b).map((x) => x.label), ["photocraft#1", NONE]);
    // Another person cannot press someone's button.
    await press("u3", rows(b).find((x) => x.label === NONE)!.custom_id!);
    assert.match(rest.callbacks[0]!.data!.content!, /expired/);
  });

  test("a junk first message is refused with the GitHub link before any question; a clean one is not checked again at submit", async () => {
    calls.length = 0; junkCalls.length = 0; filed.length = 0;
    junkResult = "junk";
    await searchCmd("u20");
    await submitForm("u20", "photocraft", "test post please ignore");
    assert.equal(calls.length, 0);
    assert.deepEqual(junkCalls.map((j) => j.body), ["test post please ignore"]);
    assert.match(rest.edits[0]!.content!, /does not look like a bug report/);
    assert.equal(new URL(rows(rest.edits[0]!)[0]!.url!).searchParams.get("body"), "test post please ignore");
    assert.equal(rows(rest.edits[0]!).some((x) => x.label === NONE), false);
    junkResult = "ok"; junkCalls.length = 0;
    await searchCmd("u21");
    await submitForm("u21", "photocraft", "webp export quality slider does nothing");
    assert.deepEqual(calls.map((c) => c.id), ["discord.issue-questions"]);
    const modal = await pressToQuestions("u21", rows(rest.edits[0]!).find((x) => x.label === NONE)!.custom_id!);
    await submit("u21", modal.data!.custom_id!, {});
    fileResult = { status: "refused", reason: "x" };
    const draftRows = rows(rest.edits[0]!);
    const editId = draftRows.find((x) => x.label === "Edit")!.custom_id!;
    await press("u21", draftRows.find((x) => x.label === "File it")!.custom_id!);
    assert.equal(junkCalls.length, 1, "only the first message was checked");
    assert.equal(filed[0]!.junkChecked, true);
    // An edited draft is checked again at submit.
    await press("u21", editId);
    await submit("u21", modalId(), { title: "Edited title", body: "Edited body" });
    await press("u21", rows(rest.edits[0]!).find((x) => x.label === "File it")!.custom_id!);
    assert.equal(filed.at(-1)!.junkChecked, false);
    filed.length = 0;
  });

  test("the search is limited to the chosen app", async () => {
    await searchCmd("u2");
    await submitForm("u2", "vectorcraft", "webp export quality");
    assert.doesNotMatch(rest.edits[0]!.content!, /photocraft#1/);
  });

  test("None: questions from the fixed list, then a checked draft with a type select; File it shows each result; Edit and the link work", async () => {
    calls.length = 0;
    draftReply = JSON.stringify({ title: "WebP export ignores quality", kind: "feature", body: "Quality has no effect. See https://evil.example/x and https://github.com/storytold/photocraft/issues/1 ping @everyone <@123>" });
    await searchCmd("u4");
    await submitForm("u4", "photocraft", "webp export quality slider does nothing");
    const noneId = rows(rest.edits[0]!).find((x) => x.label === NONE)!.custom_id!;
    assert.equal(calls.filter((c) => c.id === "discord.issue-questions").length, 1, "started at submit");
    const modal = await pressToQuestions("u4", noneId);
    assert.equal(calls.filter((c) => c.id === "discord.issue-questions").length, 1);
    assert.equal(modal.type, 9);
    const fields = (modal.data as unknown as { components: { components: { custom_id: string }[] }[] }).components.map((r) => r.components[0]!);
    assert.deepEqual(fields.map((f) => f.custom_id), ["steps", "env"]);
    await submit("u4", modal.data!.custom_id!, { steps: "Export twice", env: "1.0 on Linux" });
    const out = rest.edits[0]!;
    const select = rows(out).find((x) => x.options)!;
    assert.deepEqual(select.options!.map((o) => [o.value, !!o.default]), [["bug", false], ["feature", true]]);
    const u = draftUrl(out);
    assert.equal(`${u.origin}${u.pathname}`, "https://github.com/storytold/photocraft/issues/new");
    assert.equal(u.searchParams.get("title"), "WebP export ignores quality");
    const body = u.searchParams.get("body")!;
    assert.match(body, /issues\/1/);
    assert.doesNotMatch(body, /evil\.example|@|<@/);
    assert.deepEqual((calls.find((c) => c.id === "discord.issue-draft")!.input as { answers: unknown[] }).answers, [{ question: "Steps to reproduce", answer: "Export twice" }, { question: "Version and platform", answer: "1.0 on Linux" }]);
    // Pressing None again, or sending the answers again, makes no new model call.
    const before = calls.length;
    await press("u4", noneId);
    assert.match(rest.callbacks[0]!.data!.content!, /already used/);
    await submit("u4", modal.data!.custom_id!, { steps: "again" });
    assert.match(rest.edits[0]!.content!, /already used/);
    assert.equal(calls.length, before);

    // File it: the person's choice of type goes with it; sign-in keeps the session, filed ends it, refused offers the link.
    const fileId = rows(out).find((x) => x.label === "File it")!.custom_id!;
    await choose("u4", select.custom_id!, ["bug"]);
    assert.equal(rest.callbacks[0]!.type, 6);
    fileResult = { status: "sign-in", url: "https://example.test/signin" };
    await press("u4", fileId);
    assert.equal(rest.callbacks[0]!.type, 5);
    assert.match(rest.edits[0]!.content!, /Sign in with GitHub/);
    assert.deepEqual(rows(rest.edits[0]!).map((x) => [x.label, x.url]), [["Sign in with GitHub", "https://example.test/signin"]]);
    fileResult = { status: "refused", reason: "You have filed 3 issues today." };
    await press("u4", fileId);
    assert.match(rest.edits[0]!.content!, /filed 3 issues today/);
    assert.equal(rows(rest.edits[0]!)[0]!.label, "Open on GitHub instead");
    fileResult = { status: "filed", number: 7, url: "https://github.com/storytold/photocraft/issues/7", login: "mira" };
    await press("u4", fileId);
    assert.equal(rest.edits[0]!.content, "Filed as photocraft#7");
    assert.equal(rows(rest.edits[0]!)[0]!.url, "https://github.com/storytold/photocraft/issues/7");
    assert.deepEqual(filed.map((f) => [f.repo, f.kind, f.title]), [["photocraft", "bug", "WebP export ignores quality"], ["photocraft", "bug", "WebP export ignores quality"], ["photocraft", "bug", "WebP export ignores quality"]]);
    assert.equal(filed[0]!.reporter, keys.hash("author", "u4"));
    await press("u4", fileId);
    assert.match(rest.callbacks[0]!.data!.content!, /expired/);
    // No prompt or reply text of the issue calls is left behind.
    assert.equal((await db.get(db.k.selectFrom("agent_run_texts").select((eb) => eb.fn.countAll<number>().as("c")).where("run_id", "in", (eb) => eb.selectFrom("agent_runs").select("id").where("step", "=", "discord-issue"))))!.c, 0);
  });

  test("Edit reopens the draft in a form prefilled with title and body; the result replaces the draft", async () => {
    draftReply = JSON.stringify({ title: "Long", body: "word ".repeat(600), kind: "bug" });
    await searchCmd("u5");
    await submitForm("u5", "photocraft", "dark mode layers panel stays light");
    // Nothing matches: the reply says so and a Continue button leads to the questions.
    assert.match(rest.edits[0]!.content!, /No similar issue was found/);
    await pressToQuestions("u5", rows(rest.edits[0]!).find((x) => x.label === "Continue")!.custom_id!);
    await submit("u5", modalId(), {});
    const out = rest.edits[0]!;
    assert.ok(out.content!.length <= 2000);
    // Too long for a link button: the link sits in the message instead.
    assert.match(new URL(/\[Open on GitHub instead\]\(<([^>]+)>\)/.exec(out.content!)![1]!).searchParams.get("body")!, /Text trimmed to fit the link/);
    await press("u5", rows(out).find((x) => x.label === "Edit")!.custom_id!);
    const edit = rest.callbacks[0]!;
    assert.equal(edit.type, 9);
    assert.equal((edit.data as unknown as { components: { components: { value: string }[] }[] }).components[0]!.components[0]!.value, "Long");
    await submit("u5", edit.data!.custom_id!, { title: "Better title", body: "Own body" });
    assert.equal(draftUrl(rest.edits[0]!).searchParams.get("title"), "Better title");
  });

  test("over the daily cap no model is asked and the draft is built from the form", async () => {
    await db.run(db.k.insertInto("settings").values({ key: "discord_issue_daily_usd", value: "0" }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
    calls.length = 0;
    await searchCmd("u6");
    await submitForm("u6", "photocraft", "dark mode layers panel stays light");
    await press("u6", rows(rest.edits[0]!).find((x) => x.label === "Continue")!.custom_id!);
    assert.equal(calls.length, 0);
    const b = rest.edits[0]!;
    const u = draftUrl(b);
    assert.match(u.searchParams.get("body")!, /layers panel stays light/);
    await db.run(db.k.deleteFrom("settings").where("key", "=", "discord_issue_daily_usd"));
  });

  test("only choosing a new issue takes a slot of the three an hour; searches do not", async () => {
    for (let k = 0; k < 1; k++) { await searchCmd("u7"); await submitForm("u7", "photocraft", "webp export quality"); assert.ok(rows(rest.edits[0]!).some((x) => x.label === NONE)); }
    for (let k = 0; k < 3; k++) {
      await searchCmd("u7");
      await submitForm("u7", "photocraft", "webp export quality");
      const modal = await pressToQuestions("u7", rows(rest.edits[0]!).find((x) => x.label === NONE)!.custom_id!);
      assert.equal(modal.type, 9, "the follow-up form opens");
    }
    await searchCmd("u7");
    await submitForm("u7", "photocraft", "webp export quality");
    await press("u7", rows(rest.edits[0]!).find((x) => x.label === NONE)!.custom_id!);
    assert.match(rest.callbacks[0]!.data!.content!, /Too many new issues/);
  });

  test("a link too long for a button goes into the text when filing is refused", async () => {
    draftReply = JSON.stringify({ title: "Long one", kind: "bug", body: "Details. ".repeat(150) });
    await searchCmd("u8");
    await submitForm("u8", "photocraft", "webp export quality slider does nothing");
    const modal = await pressToQuestions("u8", rows(rest.edits[0]!).find((x) => x.label === NONE)!.custom_id!);
    await submit("u8", modal.data!.custom_id!, { steps: "x", env: "y" });
    fileResult = { status: "refused", reason: "No." };
    await press("u8", rows(rest.edits[0]!).find((x) => x.label === "File it")!.custom_id!);
    const e = rest.edits[0]!;
    assert.match(e.content!, /\[Open on GitHub instead\]\(<https:\/\/github\.com\//);
    assert.ok(!rows(e).some((x) => x.url && x.url.length > 512));
  });
});

test("the sanitizer removes foreign link targets and hidden comments", () => {
  const repos = [{ owner: "storytold", name: "photocraft" }];
  const out = sanitize("[a](//evil.example/x) ![b](/rel.png) [c](https://github.com/storytold/photocraft/issues/2) <!-- hidden", repos);
  assert.doesNotMatch(out, /evil|rel\.png|hidden/);
  assert.match(out, /issues\/2/);
  assert.equal(sanitize("x <!-- c --> y", repos), "x  y");
});
