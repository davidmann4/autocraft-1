// "Merge #n and open a follow-up issue": the press runs the merge command and holds the issue; the Act step opens it once after the PR
// merged and drops it when the PR closes unmerged or the merge approval it was held under ends first.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { runAct } from "../src/act/index.ts";
import { doCard } from "../src/conversations/act.ts";
import { parseReply, storedCard } from "../src/conversations/cards.ts";
import { filingOutcome, heldOf, heldVerdict, holdFollowup, HELD_STUCK_MS } from "../src/conversations/held.ts";
import { loadDueHeld } from "../src/data/conversations/index.ts";
import type { Exec } from "../src/fixup/git.ts";
import { liveWorkflow } from "../src/workflow/store.ts";
import { parse } from "../src/workflow/parse.ts";
import { runCommand } from "../src/workflow/apply.ts";
import { T0, world, type World } from "./world-db.ts";

let current: World | null = null;
afterEach(() => current?.close());

const app = async (w: World) => await w.db.run(w.db.k.insertInto("main.settings").values({ key: "github_identity", value: "app" }).onConflict((oc) => oc.column("key").doUpdateSet({ value: "app" })));
const canWrite = async () => true;

test("a follow-up issue on a merge command card is opened once after the merge, also after a hold, and dropped when the PR closes or other work takes its place first", async () => {
  current = await (await (await (await (await (await world()).repo()).pr(1)).pr(2)).pr(3)).pr(4);
  const w = current;
  await app(w);
  const created: string[] = [];
  const exec: Exec = async (cmd, args) => {
    if (cmd === "gh" && args[0] === "issue" && args[1] === "create") { created.push(args[args.indexOf("--title") + 1]!); return { code: 0, stdout: `https://github.com/storytold/app/issues/${100 + created.length}\n`, stderr: "" }; }
    throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
  };
  const press = async (n: number) => {
    const steps = [{ kind: "open_issue", repo: "app", title: `Follow-up of ${n}`, body: "The parser still drops the last line." }, { kind: "command", text: "merge" }];
    const [c] = (await parseReply(w.db, "app", n, `Text.\n\`\`\`actions\n${JSON.stringify([{ kind: "resolution", steps }])}\n\`\`\``))!.cards;
    const card = Number((await w.db.get(w.db.k.insertInto("conversation_cards").values({ turn_id: 0, repo: "app", number: n, ...storedCard(c!), seen: JSON.stringify({ head: `sha${n}`, last_comment: null }) }).returning("id")))!.id);
    const r = await doCard(w.db, card, "op", { ...w.gh.actDeps(), exec, canWrite });
    assert.equal(r.card.state, "done", r.card.error ?? "");
  };
  for (const n of [1, 2, 3, 4]) await press(n);
  assert.deepEqual(created, [], "nothing is opened at the press");
  const held = async () => await w.db.all(w.db.k.selectFrom("held_followups").selectAll().orderBy("number"));
  for (const h of await held()) {
    const wf = (await liveWorkflow(w.db, "app", h.number))!;
    assert.deepEqual([h.state, h.workflow_id, h.approved_at], ["held", wf.id, wf.approvedAt], "bound to the workflow and the approval of the press");
  }
  const say = async (text: string, number: number) => assert.equal((await runCommand(w.db, { login: "op", canWrite }, "dashboard", { parsed: parse(text), items: [{ repo: "app", number }] })).items[0]!.outcome, "run");
  // PRs 3 and 4 are held: nothing is due. PR 4 is resumed and merges; PR 3 is started anew.
  for (const n of [3, 4]) await say("hold", n);
  assert.deepEqual((await loadDueHeld(w.db, { now: new Date() })).rows.map((h) => heldVerdict(h)), [null, null, null, null]);
  await new Promise((r) => setTimeout(r, 5));
  await say("resume", 4);
  await say("review", 3);
  await w.db.run(w.db.k.updateTable("items").set({ state: "MERGED", merged_at: new Date(Date.now() + 60_000).toISOString() }).where("repo", "=", "app").where("number", "=", 4));
  await w.db.run(w.db.k.updateTable("items").set({ state: "MERGED", merged_at: new Date(Date.now() + 60_000).toISOString() }).where("repo", "=", "app").where("number", "=", 1));
  await w.db.run(w.db.k.updateTable("items").set({ state: "CLOSED" }).where("repo", "=", "app").where("number", "=", 2));
  // The issues are filed by the box account here: the test registers no app to mint a token with.
  await w.db.run(w.db.k.deleteFrom("main.settings").where("key", "=", "github_identity"));
  for (let k = 0; k < 2; k++) await runAct(w.db, { repo: "app", dryRun: false }, () => {}, { ...w.gh.actDeps(), exec });

  assert.deepEqual(created, ["Follow-up of 1", "Follow-up of 4"], "opened once, after the merge");
  const [one, two, three, four] = await held();
  assert.deepEqual([one!.state, four!.state], ["filed", "filed"]);
  assert.ok(one!.issue_number);
  assert.deepEqual([two!.state, three!.state], ["dropped", "dropped"]);
  assert.match(String(two!.reason), /closed without merging/);
});

test("a row left in filing is settled from its audit row, and a merged PR files a row without a workflow", async () => {
  current = await (await (await world()).repo()).pr(1);
  const w = current;
  const audit = (action: string, at: string, target: string | null, details: string | null) => w.db.run(w.db.k.insertInto("audit").values({ at, login: "op", action, target, details }));
  const id = await holdFollowup(w.db, { card_id: 0, workflow_id: null, approved_at: null, repo: "app", number: 1, issue_repo: "app", title: "t", body: "b", by: "op", at: T0 });
  const due = async () => (await loadDueHeld(w.db, { now: new Date(T0) })).rows.find((h) => h.id === id)!;
  assert.equal(heldVerdict(await due()), null, "the PR is open");
  await w.db.run(w.db.k.updateTable("items").set({ state: "MERGED", merged_at: "2026-01-02T10:00:00Z" }).where("repo", "=", "app").where("number", "=", 1));
  assert.deepEqual(heldVerdict(await due()), { file: true });

  await w.db.run(w.db.k.updateTable("held_followups").set({ state: "filing", updated_at: T0 }).where("id", "=", id));
  const later = Date.parse(T0) + HELD_STUCK_MS + 1;
  assert.equal((await heldOf(w.db, "app", 1))[0]!.state, "filing");
  assert.deepEqual(filingOutcome(await due(), later), { state: "held" });
  await audit("act-open-issue", "2026-01-02T08:00:00Z", "app#1", "not json");
  await audit("act-open-issue", "2026-01-02T08:01:00Z", "app#1", JSON.stringify({ held: id + 1, state: "done", url: "https://github.com/storytold/app/issues/5" }));
  assert.deepEqual(filingOutcome(await due(), later), { state: "held" }, "another row's create does not settle this one");
  await audit("act-open-issue", "2025-12-31T08:00:00Z", "app#1", JSON.stringify({ held: id, state: "failed", error: "HTTP 403" }));
  assert.deepEqual(filingOutcome(await due(), later), { state: "held" }, "a refused earlier try does not settle this filing");
  await audit("act-open-issue", "2026-01-02T08:01:10Z", "app#1", JSON.stringify({ held: id, state: "failed", error: "GraphQL: API rate limit already exceeded" }));
  assert.deepEqual(filingOutcome(await due(), later), { state: "held" }, "a create GitHub refused made nothing");
  for (const state of ["started", "failed"]) {
    await audit("act-open-issue", "2026-01-02T08:01:30Z", "app#1", JSON.stringify({ held: id, state }));
    assert.equal(filingOutcome(await due(), later), null, `a create that is ${state} may have opened the issue`);
  }
  let creates = 0;
  const exec: Exec = async (_cmd, args) => { if (args[1] === "create") creates++; return { code: 1, stdout: "", stderr: "timeout" }; };
  await runAct(w.db, { repo: "app", dryRun: false }, () => {}, { ...w.gh.actDeps(), exec });
  assert.deepEqual([creates, (await heldOf(w.db, "app", 1))[0]!.state], [0, "filing"], "a create of unknown outcome is not made again");
  await audit("act-open-issue", "2026-01-02T08:02:00Z", "app#1", JSON.stringify({ held: id, state: "done", url: "https://github.com/storytold/app/issues/7" }));
  assert.deepEqual(filingOutcome(await due(), later), { state: "filed", number: 7, url: "https://github.com/storytold/app/issues/7" });
});
