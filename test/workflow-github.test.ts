// GitHub in a repo on the maintainer workflow: answers need the app's mention, strangers with write access get one "link your
// account" answer a week, and a quiet PR's status comment says nothing about findings or the recommendation.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { safeEqual } from "../src/dash/server/crypto.ts";
import { recordSteps, startAttempt } from "../src/data/implement/index.ts";
import { drainCommands, type CommandDeps, type CommentNow } from "../src/github/commands.ts";
import { handleDelivery, signatureOf } from "../src/github/webhooks.ts";
import { statusDue } from "../src/prstatus/index.ts";
import type { AppPermission } from "../src/remote/permission.ts";
import { insertWorkflow, liveWorkflow, updateWorkflow } from "../src/workflow/store.ts";
import { OPERATOR, T0, world, type World } from "./world-db.ts";

const SLUG = "autocraft-bot";
const SECRET = "hook-secret";
const OP_ID = 101;

let current: World | undefined;
afterEach(() => current?.close());

/** The repo "app" on the maintainer workflow, with the app identity and the operator bound to a GitHub id. */
async function newRepo(): Promise<World> {
  const w = current = await (await world()).repo();
  const db = w.db;
  await db.run(db.k.updateTable("main.tracked_repos").set({ workflow: "new" }).where("name", "=", "app"));
  await db.run(db.k.insertInto("main.settings").values({ key: "github_identity", value: "app" }).onConflict((oc) => oc.column("key").doUpdateSet({ value: "app" })));
  await db.run(db.k.updateTable("main.access").set({ github_id: OP_ID }).where("login", "=", OPERATOR));
  return w;
}

const bodies = new Map<number, string>();
let nextComment = 7000;
async function comment(w: World, body: string, o: { login?: string; id?: number; number?: number } = {}): Promise<number> {
  const id = nextComment++;
  bodies.set(id, body);
  const p = {
    action: "created", repository: { full_name: "storytold/app", name: "app" }, issue: { number: o.number ?? 1, pull_request: { url: "x" } },
    comment: { id, body, created_at: new Date().toISOString(), user: { login: o.login ?? OPERATOR, id: o.id ?? OP_ID, type: "User" } },
  };
  const raw = Buffer.from(JSON.stringify(p));
  await handleDelivery(w.db, SECRET, { event: "issue_comment", signature: signatureOf(SECRET, raw) }, raw, safeEqual, SLUG);
  return id;
}

const PERM: Record<"write" | "read", AppPermission> = { write: { kind: "ok", permission: "write" }, read: { kind: "ok", permission: "read" } };
/** Drains after the re-reads, with GitHub answering: the comment as written, each PR unchanged at its mirror head. */
async function drain(w: World, perm: "write" | "read" = "write") {
  const db = w.db;
  for (const { number } of await db.all(db.k.selectFrom("main.github_commands").select("number").distinct())) {
    await db.run(db.k.insertInto("main.item_reads").values({ repo: "app", number, synced_at: new Date(Date.now() + 1000).toISOString() })
      .onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet({ synced_at: new Date(Date.now() + 1000).toISOString() })));
  }
  const deps: CommandDeps = {
    querier: w.gh.querier, permission: async () => PERM[perm], slug: SLUG,
    comment: async (_repo, id): Promise<CommentNow> => {
      const r = (await db.get(db.k.selectFrom("main.github_commands").select("github_id").where("comment_id", "=", id)))!;
      return { kind: "ok", authorId: r.github_id, body: bodies.get(id)! };
    },
    pr: async (_q, _repo, n) => ({ head: (await db.get(db.k.selectFrom("main.items").select("head_oid").where("repo", "=", "app").where("number", "=", n)))!.head_oid!, opened: T0, changed: false }),
  };
  return await drainCommands(db, deps);
}
const commands = async (w: World) => await w.db.all(w.db.k.selectFrom("main.github_commands").select(["comment_id", "command", "state", "result", "reply"]).orderBy("comment_id"));

test("a comment without the app's mention runs nothing; the same words with it start the item", async () => {
  const w = await newRepo();
  await w.pr(1);
  await comment(w, "fix-up and merge");
  await comment(w, `Looks good, please ask @${SLUG} review`);
  await comment(w, `> @${SLUG} review`);
  await drain(w);
  assert.deepEqual(await commands(w), [], "nothing is queued");
  assert.equal(await liveWorkflow(w.db, "app", 1), null);

  await comment(w, `@${SLUG} review`);
  await drain(w);
  const [r] = await commands(w);
  assert.equal(r?.command, "answer");
  assert.equal(r?.state, "done", r?.result ?? "");
  assert.match(r!.result!, /Reviewing/);
  assert.notEqual(r!.reply, "none", "the confirmation is answered in the thread");
  assert.equal((await liveWorkflow(w.db, "app", 1))?.entry, "review");
});

test("a commenter with write access but no bound AutoCraft login gets one link-your-account answer a week; one without write gets none", async () => {
  const w = await newRepo();
  await w.pr(1);
  const answered = async () => (await commands(w)).filter((r) => r.reply !== "none").length;

  await comment(w, `@${SLUG} review`, { login: "reader", id: 300 });
  await drain(w, "read");
  assert.equal(await answered(), 0, "no write access: no answer");

  await comment(w, `@${SLUG} review`, { login: "stranger", id: 301 });
  await drain(w);
  assert.equal(await answered(), 1);
  assert.match((await commands(w)).at(-1)!.result!, /sign in/i);

  await comment(w, `@${SLUG} merge`, { login: "stranger", id: 301 });
  await drain(w);
  assert.equal(await answered(), 1, "a second comment in the same week gets no answer");
  assert.equal(await liveWorkflow(w.db, "app", 1), null, "nothing ran");

  await w.db.run(w.db.k.updateTable("main.github_link_nudges").set({ at: new Date(Date.now() - 8 * 86400_000).toISOString() }));
  await comment(w, `@${SLUG} merge`, { login: "stranger", id: 301 });
  await drain(w);
  assert.equal(await answered(), 2, "after a week the next comment is answered again");
});

test("a quiet PR's status comment carries no findings or recommendation text", async () => {
  const w = await newRepo();
  const db = w.db;
  await w.pr(1);
  await w.pr(2);
  await db.run(db.k.updateTable("main.items").set({ url: "https://github.com/storytold/app/pull/1" }).where("number", "=", 1));
  await db.run(db.k.updateTable("main.items").set({ url: "https://github.com/storytold/app/pull/2" }).where("number", "=", 2));
  const rec = { text: "Fix the bounds check in the token parser, then merge.", parts: { fix: [1], drop: [] }, merges: true };
  const plan = [{ n: 1, title: "Token parser reads past the buffer", source: "review" as const, major: true, state: "planned" as const }];
  for (const n of [1, 2]) {
    const id = await insertWorkflow(db, { repo: "app", number: n, kind: "pr", entry: "review", state: "running", startedBy: OPERATOR, startedAt: T0, startedVia: "github" }, T0);
    await updateWorkflow(db, id, { state: "recommending", rec, recAt: T0, plan }, T0);
  }
  await db.run(db.k.insertInto("main.security_findings").values({ repo: "app", number: 1, scan_id: 900, area: "a", title: "t", severity: "high", urgent: 0, state: "landing", refs: "[]", reach: "r", impact: "i", fingerprint: "fp1", created_at: T0, updated_at: T0, fix_pr: 1 }));

  const due = new Map((await statusDue(db, "app")).map((d) => [d.number, d.line]));
  const quiet = due.get(1)!, open = due.get(2)!;
  assert.ok(quiet && open, "both started PRs get a comment");
  for (const secret of [rec.text, plan[0]!.title]) {
    assert.ok(open.includes(secret), "an ordinary PR shows it");
    assert.ok(!quiet.includes(secret), "the quiet PR does not");
  }
  assert.doesNotMatch(quiet, /finding/i);
});

test("a stop comment on the pull request of an implementation halts the issue's work and answers in the thread", async () => {
  const w = await newRepo();
  await w.acting(OPERATOR);
  await w.issue(7);
  await w.pr(8, { author: "craft-bot" });
  const id = await insertWorkflow(w.db, { repo: "app", number: 7, kind: "issue", entry: "implement", state: "running", startedBy: OPERATOR, startedAt: T0, startedVia: "github" });
  const im = (await startAttempt(w.db, { repo: "app", number: 7, queuedBy: OPERATOR, textHash: "h" }))!;
  await recordSteps(w.db, [{ id: im.id, to: "pr-opened", patch: { prNumber: 8, branch: "fix-8", prUrl: "https://example.invalid/8" } }]);
  await comment(w, `@${SLUG} review`, { number: 8 });
  await comment(w, `@${SLUG} stop`, { number: 8 });
  await drain(w);
  const [review, stop] = await commands(w);
  assert.deepEqual([review!.state, stop!.state], ["refused", "done"], `${review!.result} / ${stop!.result}`);
  assert.match(stop!.result!, /app#7: On hold \(held by /);
  assert.equal(await liveWorkflow(w.db, "app", 7), null);
  assert.equal((await w.db.get(w.db.k.selectFrom("main.item_workflows").select("stopped_by").where("id", "=", id)))!.stopped_by, OPERATOR);
});
