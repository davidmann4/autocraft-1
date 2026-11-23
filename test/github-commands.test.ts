// Commands in GitHub comments: `@<app> merge queue` from an operator queues the item as Queue items does and the app answers.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { safeEqual } from "../src/dash/server/crypto.ts";
import { drainCommands, parseCommand, prSince, STALE_MS, type CommandDeps, type CommentNow, type PrNow } from "../src/github/commands.ts";
import { handleDelivery, signatureOf } from "../src/github/webhooks.ts";
import type { Exec } from "../src/fixup/git.ts";
import { fastTrackList } from "../src/fasttrack.ts";
import { preapprovalOf } from "../src/preapproval/index.ts";
import { OPERATOR, world, type World } from "./world-db.ts";
import { validating } from "./gql.ts";
import type { AppPermission } from "../src/remote/permission.ts";
import * as kx from "../src/db/kx.ts";

const SLUG = "autocraft-bot";
const SECRET = "hook-secret";
const OP_ID = 101;

let current: World | null = null;
const fresh = async (off: Parameters<World["repo"]>[0] = []): Promise<World> => {
  const w = (current = await (await world()).repo(off));
  await w.db.run(w.db.k.updateTable("access").set({ github_id: OP_ID }).where("login", "=", OPERATOR));
  return w;
};
afterEach(() => current?.close());

const payload = (o: { body: string; number?: number; login?: string; id?: number; comment?: number; action?: string; type?: string; pr?: boolean; repo?: string; created?: Date }) => ({
  action: o.action ?? "created",
  repository: { full_name: o.repo ?? "storytold/app", name: "app" },
  issue: { number: o.number ?? 1, ...(o.pr === false ? {} : { pull_request: { url: "x" } }) },
  comment: { id: o.comment ?? 5000, body: o.body, created_at: (o.created ?? new Date()).toISOString(), user: { login: o.login ?? OPERATOR, id: o.id ?? OP_ID, type: o.type ?? "User" } },
});
const deliver = async (w: World, p: unknown, slug: string | null = SLUG) => {
  const raw = Buffer.from(JSON.stringify(p));
  return await handleDelivery(w.db, SECRET, { event: "issue_comment", signature: signatureOf(SECRET, raw) }, raw, safeEqual, slug);
};
const rows = async (w: World) => (await w.db.all(w.db.k.selectFrom("github_commands").select(["comment_id", "number", "pr", "weight", "login", "state", "result", "reply"]).orderBy("comment_id"))).map((r) => ({ ...r }));

/** A fake gh that records the comments it posts. */
function ghFake(code = 0) {
  const posted: { args: string[]; body: string }[] = [];
  const exec: Exec = async (_cmd, args, opts) => {
    posted.push({ args, body: String(opts?.input ?? "") });
    return { code, stdout: code ? "" : "https://github.com/storytold/app/pull/1#issuecomment-9", stderr: code ? "boom" : "" };
  };
  return { posted, exec };
}
/** GitHub as the stubs answer it: the comment as written (by its stored commenter and weight), each PR at its mirror head, opened long ago and unchanged. */
const stillThere = (w: World) => async (_repo: string, id: number): Promise<CommentNow> => {
  const r = (await w.db.get(w.db.k.selectFrom("github_commands").select(["github_id", "weight", "bypass"]).where("comment_id", "=", id)))!;
  return { kind: "ok", authorId: r.github_id, body: `@${SLUG} merge queue${r.weight === null ? "" : ` ${r.weight}`}${r.bypass ? " lgtm" : ""}` };
};
const unchanged = (w: World) => async (_q: unknown, _repo: string, n: number): Promise<PrNow | null> =>
  ({ head: (await w.db.get(w.db.k.selectFrom("items").select("head_oid").$narrowType<{ head_oid: string }>().where("repo", "=", "app").where("number", "=", n)))!.head_oid, opened: "2020-01-01T00:00:00Z", changed: false });
const WRITE: AppPermission = { kind: "ok", permission: "write" };
const FAILED: AppPermission = { kind: "error", why: "GitHub permission check failed: HTTP 502" };
const PERMS: Record<"ok" | "no" | "transient", AppPermission> = { ok: WRITE, no: { kind: "ok", permission: "read" }, transient: FAILED };
const deps = (w: World, o: Partial<CommandDeps> & { perm?: "ok" | "no" | "transient" } = {}): CommandDeps => ({
  querier: w.gh.querier, permission: async () => PERMS[o.perm ?? "ok"], comment: stillThere(w), pr: unchanged(w), slug: SLUG, ...o,
});
/** The item was read from GitHub at `at` (as the webhook's re-read or the poll write it). */
const readAt = async (w: World, number: number, at: Date) =>
  await w.db.run(w.db.k.insertInto("item_reads").values({ repo: "app", number, synced_at: at.toISOString() }).onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(kx.excluded(["synced_at"]))));
/** Drains after the re-reads: every commanded item was read just now. */
const drained = async (w: World, o: Parameters<typeof deps>[1] = {}) => {
  await w.db.run(w.db.k.deleteFrom("sync_requests"));
  for (const { number } of await w.db.all(w.db.k.selectFrom("github_commands").select("number").distinct())) await readAt(w, number, new Date(Date.now() + 1000));
  return drainCommands(w.db, deps(w, o));
};

describe("parseCommand", () => {
  test("a line of its own addressed to the app, any case and spelling, with an optional weight", () => {
    assert.deepEqual(parseCommand(`@${SLUG} merge queue`, SLUG), { command: "merge-queue", weight: null, bypass: false });
    assert.deepEqual(parseCommand(`Looks good.\n\n  @Autocraft-Bot Merge-Queue!  \nthanks`, SLUG), { command: "merge-queue", weight: null, bypass: false });
    assert.deepEqual(parseCommand(`@${SLUG} mergequeue 8`, SLUG), { command: "merge-queue", weight: 8, bypass: false });
    assert.deepEqual(parseCommand(`@${SLUG}[bot]: merge queue weight 3`, SLUG), { command: "merge-queue", weight: 3, bypass: false });
    assert.deepEqual(parseCommand(`@${SLUG} merge queue 42`, SLUG), { command: "merge-queue", weight: 42, bypass: false }, "the range is checked when it is carried out");
  });

  test("bypass, bypass checks or lgtm before or after the weight queues with bypass checks; mq is short for merge queue", () => {
    assert.deepEqual(parseCommand(`@${SLUG} mq lgtm`, SLUG), { command: "merge-queue", weight: null, bypass: true });
    assert.deepEqual(parseCommand(`@${SLUG} mq`, SLUG), { command: "merge-queue", weight: null, bypass: false });
    assert.deepEqual(parseCommand(`@${SLUG} merge queue bypass checks 8`, SLUG), { command: "merge-queue", weight: 8, bypass: true });
    assert.deepEqual(parseCommand(`@${SLUG} merge queue weight 3 bypass`, SLUG), { command: "merge-queue", weight: 3, bypass: true });
    for (const body of [`@${SLUG} mq lgtm lgtm`, `@${SLUG} mq bypass 3 lgtm`, `@${SLUG} mq looks good`, `@${SLUG} mqlgtm`]) assert.equal(parseCommand(body, SLUG), null, body);
  });

  test("other apps, other words, quotes, code and text around the command do not count", () => {
    for (const body of [
      "@other-bot merge queue", `@${SLUG}x merge queue`, `please @${SLUG} merge queue`, `@${SLUG} merge queue now please`,
      `> @${SLUG} merge queue`, "```\n@" + SLUG + " merge queue\n```", `@${SLUG} merge`, "", `@${SLUG} merge queue 123`,
    ]) assert.equal(parseCommand(body, SLUG), null, body);
    assert.equal(parseCommand(`@${SLUG} merge queue`, ""), null);
    assert.equal(parseCommand(null, SLUG), null);
    assert.equal(parseCommand(`@a.b merge queue`, "a-b"), null, "the slug is matched literally");
  });

  test("a fence closes only with its own character, at least its length and nothing after it", () => {
    const cmd = `@${SLUG} merge queue`;
    for (const body of [
      "````\n```\n" + cmd + "\n````", // a shorter fence inside stays code
      "```\n~~~\n" + cmd + "\n```", // the other character stays code
      "```\n``` not a close\n" + cmd + "\n```", // text after the fence is no close
      "~~~~\n~~~\n" + cmd, // an unclosed fence runs to the end
    ]) assert.equal(parseCommand(body, SLUG), null, body);
    for (const body of ["````\ncode\n`````  \n" + cmd, "~~~ js\ncode\n~~~\n" + cmd, "```\n```\n" + cmd]) assert.notEqual(parseCommand(body, SLUG), null, body);
  });
});

describe("webhook", () => {
  test("a new comment with a command is queued once with the commenter, never its text; other comments queue none", async () => {
    const w = await (await fresh()).pr(1);
    assert.equal((await deliver(w, payload({ body: `@${SLUG} merge queue 7` }))).status, 202);
    assert.equal((await deliver(w, payload({ body: `@${SLUG} merge queue 7` }))).status, 202, "a redelivery");
    await deliver(w, payload({ body: `@${SLUG} merge queue`, comment: 5001, action: "edited" }));
    await deliver(w, payload({ body: `@${SLUG} merge queue`, comment: 5002, type: "Bot" }));
    await deliver(w, payload({ body: "just a comment", comment: 5003 }));
    await deliver(w, payload({ body: `@${SLUG} merge queue`, comment: 5004, repo: "someoneelse/app" }));
    await deliver(w, payload({ body: `@${SLUG} merge queue`, comment: 5005 }), null);
    await deliver(w, payload({ body: `@${SLUG} merge queue`, comment: 5006, login: "bad login" }));
    assert.deepEqual(await rows(w), [{ comment_id: 5000, number: 1, pr: 1, weight: 7, login: OPERATOR, state: "queued", result: null, reply: null }]);
    const cols = (await w.db.k.introspection.getTables()).find((t) => t.name === "github_commands")!.columns.map((c) => c.name);
    assert.ok(!cols.includes("body"), "the comment's text has no column");
    assert.deepEqual((await w.db.all(w.db.k.selectFrom("sync_requests").select("number"))).map((r) => ({ ...r })), [{ number: 1 }], "the item is still re-read");
  });
});

describe("drainCommands", () => {
  test("an operator with write access queues the PR as Queue items does, and the app answers in the thread", async () => {
    const w = await (await fresh()).pr(1);
    await deliver(w, payload({ body: `@${SLUG} merge queue 7` }));
    const gh = ghFake();
    assert.equal(await drained(w, { exec: gh.exec }), 1);
    assert.equal((await preapprovalOf(w.db, "app", 1))?.state, "review");
    assert.deepEqual((await fastTrackList(w.db)).map((f) => [f.number, f.weight]), [[1, 7]]);
    const [r] = await rows(w) as { state: string; reply: string; result: string }[];
    assert.equal(r!.state, "done");
    assert.equal(r!.reply, "posted");
    assert.equal(gh.posted.length, 1);
    assert.deepEqual(gh.posted[0]!.args.slice(0, 5), ["pr", "comment", "1", "--repo", "storytold/app"]);
    assert.match(gh.posted[0]!.body, /^_Automated reply_\n\n@op Added to the merge queue; .*Fast-tracked with weight 7, 1 of 1\.$/);
    const audit = await w.db.all(w.db.k.selectFrom("audit").select(["action", "login", "details"])
      .where("action", "in", ["preapproval", "fasttrack-add", "github-command", "github-command-reply"]).orderBy(kx.rowid("audit")));
    assert.deepEqual(audit.map((a) => [a.action, a.login]), [["preapproval", OPERATOR], ["fasttrack-add", OPERATOR], ["github-command", OPERATOR], ["github-command-reply", OPERATOR]]);
    assert.equal(JSON.parse(audit[1]!.details!).via, "github");
    assert.equal(JSON.parse(audit[3]!.details!).state, "done");
    assert.equal(await drained(w, { exec: gh.exec }), 0, "nothing is left");
    assert.equal(gh.posted.length, 1);
  });

  test("the command waits until the item was read from GitHub after the comment, also when the re-read failed and its request is gone", async () => {
    const w = await (await fresh()).pr(1);
    await readAt(w, 1, new Date(Date.now() - 60_000));
    await deliver(w, payload({ body: `@${SLUG} merge queue` }));
    const gh = ghFake();
    assert.equal(await drainCommands(w.db, deps(w, { exec: gh.exec })), 0, "the re-read is still queued");
    await w.db.run(w.db.k.deleteFrom("sync_requests"));
    assert.equal(await drainCommands(w.db, deps(w, { exec: gh.exec })), 0, "the request is gone but the last read is older than the comment");
    assert.equal((await rows(w))[0]!.state, "queued");
    assert.equal(await preapprovalOf(w.db, "app", 1), null);
    assert.deepEqual((await w.db.all(w.db.k.selectFrom("sync_requests").select("number"))).map((r) => ({ ...r })), [{ number: 1 }], "the command asks for a new read");
    await w.db.run(w.db.k.deleteFrom("sync_requests"));
    await readAt(w, 1, new Date(Date.now() + 1000));
    assert.equal(await drainCommands(w.db, deps(w, { exec: gh.exec })), 0, "it looks again a minute after asking");
    const later = new Date(Date.now() + 2 * 60_000);
    assert.equal(await drainCommands(w.db, deps(w, { exec: gh.exec, now: () => later })), 1, "the new read came after the comment");
    assert.equal((await preapprovalOf(w.db, "app", 1))?.state, "review");
  });

  test("a read stamped at the comment's own instant does not count: it may have started before it", async () => {
    const w = await (await fresh()).pr(1);
    await deliver(w, payload({ body: `@${SLUG} merge queue` }));
    await w.db.run(w.db.k.deleteFrom("sync_requests"));
    const at = (await w.db.get(w.db.k.selectFrom("github_commands").select("requested_at")))!.requested_at;
    await readAt(w, 1, new Date(at));
    assert.equal(await drainCommands(w.db, deps(w, { exec: ghFake().exec })), 0);
    assert.equal(await preapprovalOf(w.db, "app", 1), null);
    await readAt(w, 1, new Date(Date.parse(at) + 1));
    assert.equal(await drainCommands(w.db, deps(w, { exec: ghFake().exec, now: () => new Date(Date.parse(at) + 2 * 60_000) })), 1, "one millisecond later counts");
  });

  test("an older read written while the permission is read from GitHub makes the command wait instead of queuing that head", async () => {
    const w = await (await fresh()).pr(1);
    await deliver(w, payload({ body: `@${SLUG} merge queue` }));
    await w.db.run(w.db.k.deleteFrom("sync_requests"));
    await readAt(w, 1, new Date(Date.now() + 1000));
    // A reconcile that started before the comment lands while the permission read waits on GitHub: it sets the read time back.
    const permission = async () => { await readAt(w, 1, new Date(Date.now() - 60_000)); return WRITE; };
    assert.equal(await drainCommands(w.db, { ...deps(w, { exec: ghFake().exec }), permission }), 0);
    assert.equal((await rows(w))[0]!.state, "queued");
    assert.equal(await preapprovalOf(w.db, "app", 1), null, "the older snapshot is not pre-approved");
    assert.deepEqual((await w.db.all(w.db.k.selectFrom("sync_requests").select("number"))).map((r) => ({ ...r })), [{ number: 1 }], "the item is read again");
  });

  test("on an issue, the PR that closes it must be read after the comment too before it is queued", async () => {
    const w = await (await (await fresh()).issue(3)).pr(4);
    await w.db.run(w.db.k.updateTable("items").set({ closing_issues: "[3]" }).where("repo", "=", "app").where("number", "=", 4));
    await readAt(w, 4, new Date(Date.now() - 60_000));
    await deliver(w, payload({ body: `@${SLUG} merge queue`, number: 3, pr: false }));
    await w.db.run(w.db.k.deleteFrom("sync_requests"));
    await readAt(w, 3, new Date(Date.now() + 1000));
    assert.equal(await drainCommands(w.db, deps(w, { exec: ghFake().exec })), 0, "the issue is fresh, its closing PR is not");
    assert.deepEqual((await w.db.all(w.db.k.selectFrom("sync_requests").select("number"))).map((r) => ({ ...r })), [{ number: 4 }], "the PR is read again");
    assert.equal(await preapprovalOf(w.db, "app", 4), null);
    await readAt(w, 4, new Date(Date.now() + 1000));
    await w.db.run(w.db.k.deleteFrom("sync_requests"));
    assert.equal(await drainCommands(w.db, deps(w, { exec: ghFake().exec, now: () => new Date(Date.now() + 2 * 60_000) })), 1);
    assert.equal((await preapprovalOf(w.db, "app", 4))?.state, "review");
  });

  test("commands that wait for a re-read or a permission retry do not keep newer ones out of a drain", async () => {
    const w = await (await (await (await fresh()).pr(1)).pr(2)).pr(3);
    await deliver(w, payload({ body: `@${SLUG} merge queue`, number: 1, comment: 7001 }));
    await deliver(w, payload({ body: `@${SLUG} merge queue`, number: 2, comment: 7002 }));
    await deliver(w, payload({ body: `@${SLUG} merge queue`, number: 3, comment: 7003 }));
    await w.db.run(w.db.k.deleteFrom("sync_requests"));
    await readAt(w, 2, new Date(Date.now() + 1000));
    await readAt(w, 3, new Date(Date.now() + 1000));
    // #1 is not read yet; #2's permission cannot be told; with one GitHub call per drain #3 still gets its turn next.
    const perm = async () => FAILED;
    await drainCommands(w.db, { ...deps(w, { exec: ghFake().exec }), permission: perm, limit: 1 });
    assert.deepEqual((await rows(w)).map((r) => r.state), ["queued", "queued", "queued"]);
    await drainCommands(w.db, { ...deps(w, { exec: ghFake().exec }), limit: 1 });
    assert.deepEqual((await rows(w)).map((r) => r.state), ["queued", "queued", "done"], "#2 waits out its retry, #3 is carried out");
    const later = new Date(Date.now() + 2 * 60_000);
    await drainCommands(w.db, { ...deps(w, { exec: ghFake().exec }), limit: 1, now: () => later });
    assert.deepEqual((await rows(w)).map((r) => r.state), ["queued", "done", "done"], "after the retry wait #2 runs; its expiry still counts from the comment");
  });

  test("a stranger, or a login now held by another GitHub account, gets no answer and changes nothing", async () => {
    const w = await (await fresh()).pr(1);
    await deliver(w, payload({ body: `@${SLUG} merge queue`, login: "stranger", id: 999 }));
    await deliver(w, payload({ body: `@${SLUG} merge queue`, comment: 5001, id: 998 }));
    const gh = ghFake();
    await drained(w, { exec: gh.exec });
    assert.deepEqual((await rows(w)).map((r) => r.state), ["ignored", "ignored"]);
    assert.equal(gh.posted.length, 0);
    assert.equal(await preapprovalOf(w.db, "app", 1), null);
  });

  test("Queue items' rule decides: a maintainer without maintainer writes and an operator without write access are refused; a viewer or a login never bound gets no answer", async () => {
    const w = await (await fresh()).pr(1);
    await w.db.run(w.db.k.insertInto("access").values([{ login: "maint", role: "maintainer", github_id: 202 }, { login: "view", role: "viewer", github_id: 404 }, { login: "newop", role: "operator", github_id: null }]));
    await deliver(w, payload({ body: `@${SLUG} merge queue`, login: "maint", id: 202 }));
    await deliver(w, payload({ body: `@${SLUG} merge queue`, comment: 5001, login: "view", id: 404 }));
    await deliver(w, payload({ body: `@${SLUG} merge queue`, comment: 5002, login: "newop", id: 303 }));
    const gh = ghFake();
    await drained(w, { exec: gh.exec });
    await deliver(w, payload({ body: `@${SLUG} merge queue`, comment: 5003 }));
    await drained(w, { exec: gh.exec, perm: "no" });
    assert.deepEqual((await rows(w)).map((r) => [r.state, r.reply]), [["refused", "posted"], ["refused", "none"], ["ignored", "none"], ["refused", "posted"]]);
    assert.equal(await preapprovalOf(w.db, "app", 1), null);
    const bodies = gh.posted.map((p) => p.body);
    assert.equal(bodies.length, 2);
    assert.match(bodies[0]!, /@maint Not added to the merge queue: only an operator, or a maintainer with write access where the app acts for them, queues items on app\.$/);
    assert.match(bodies[1]!, /@op Not added to the merge queue: no write access to storytold\/app/);
    assert.equal((await w.db.get(w.db.k.selectFrom("access").select("github_id").where("login", "=", "newop")))!.github_id, null, "a comment never binds an id");
  });

  test("a maintainer who settles decisions on the repo queues, as with Queue items; without write access they do not", async () => {
    const w = await (await (await fresh()).pr(1)).pr(2);
    await w.db.run(w.db.k.insertInto("access").values({ login: "maint", role: "maintainer", github_id: 202 }));
    await w.db.run(w.db.k.insertInto("settings").values([{ key: "maintainer_writes", value: "1" }, { key: "github_identity", value: "app" }]).onConflict((oc) => oc.column("key").doUpdateSet(kx.excluded(["value"]))));
    await deliver(w, payload({ body: `@${SLUG} merge queue`, login: "maint", id: 202, number: 2, comment: 6000 }));
    await drained(w, { exec: ghFake().exec, perm: "no" });
    assert.equal((await rows(w))[0]!.state, "refused");
    assert.equal(await preapprovalOf(w.db, "app", 2), null);
    await deliver(w, payload({ body: `@${SLUG} merge queue`, login: "maint", id: 202, comment: 6001 }));
    await drained(w, { exec: ghFake().exec });
    assert.equal((await rows(w))[1]!.state, "done");
    assert.equal((await preapprovalOf(w.db, "app", 1))?.by, "maint");
  });

  test("queueAdd's refusal is the answer; an unclear permission keeps the command for later", async () => {
    const w = await (await fresh(["merge"])).pr(1);
    await deliver(w, payload({ body: `@${SLUG} merge queue` }));
    const gh = ghFake();
    await drained(w, { exec: gh.exec, perm: "transient" });
    assert.equal((await rows(w))[0]!.state, "queued");
    assert.equal(gh.posted.length, 0);
    await drained(w, { exec: gh.exec });
    assert.equal((await rows(w))[0]!.state, "queued", "the retry waits a minute");
    await drained(w, { exec: gh.exec, now: () => new Date(Date.now() + 2 * 60_000) });
    assert.equal((await rows(w))[0]!.state, "refused");
    assert.match(gh.posted[0]!.body, /@op Not added to the merge queue: merging is not approved for app\.$/);
  });

  test("an issue is fast-tracked; an answer that fails is recorded and not posted again", async () => {
    const w = await (await fresh()).issue(3);
    await deliver(w, payload({ body: `@${SLUG} merge queue`, number: 3, pr: false }));
    const gh = ghFake(1);
    await drained(w, { exec: gh.exec });
    assert.deepEqual((await fastTrackList(w.db)).map((f) => f.number), [3]);
    assert.equal(gh.posted[0]!.args[0], "issue");
    assert.deepEqual((await rows(w)).map((r) => [r.state, r.reply]), [["done", "failed"]]);
    await drained(w, { exec: gh.exec });
    assert.equal(gh.posted.length, 1);
  });

  test("a command not carried out within an hour is dropped unanswered", async () => {
    const w = await (await fresh()).pr(1);
    await deliver(w, payload({ body: `@${SLUG} merge queue` }));
    const gh = ghFake();
    await drained(w, { exec: gh.exec, now: () => new Date(Date.now() + 2 * 3600_000) });
    assert.deepEqual((await rows(w)).map((r) => r.state), ["expired"]);
    assert.equal(gh.posted.length, 0);
  });

  test("due retries do not keep a command that was never tried out, also with drains minutes apart", async () => {
    const w = await (await (await (await fresh()).pr(1)).pr(2)).pr(3);
    for (const n of [1, 2, 3]) await deliver(w, payload({ body: `@${SLUG} merge queue`, number: n, comment: 8000 + n }));
    await w.db.run(w.db.k.deleteFrom("sync_requests"));
    for (const n of [1, 2, 3]) await readAt(w, n, new Date(Date.now() + 1000));
    // One GitHub call per drain, drains two minutes apart, so a retry is due again at every drain. GitHub cannot tell the
    // permission for the first two calls. Oldest first alone would retry #1 at every drain and never reach #3.
    let calls = 0;
    const permission = async () => (++calls <= 2 ? FAILED : WRITE);
    for (const k of [0, 1, 2]) {
      const at = new Date(Date.now() + k * 2 * 60_000);
      await drainCommands(w.db, { ...deps(w, { exec: ghFake().exec, now: () => at }), limit: 1, permission });
    }
    const state = Object.fromEntries((await rows(w)).map((r) => [r.number, r.state]));
    assert.deepEqual(state, { 1: "queued", 2: "queued", 3: "done" }, "#2 and then #3 were tried before #1 again");
  });

  test("the role and binding are read again after the permission read: a demoted or rebound commenter queues nothing", async () => {
    const w = await (await (await fresh()).pr(1)).pr(2);
    await deliver(w, payload({ body: `@${SLUG} merge queue`, number: 1, comment: 9001 }));
    await w.db.run(w.db.k.deleteFrom("sync_requests"));
    await readAt(w, 1, new Date(Date.now() + 1000));
    const gh = ghFake();
    // Demoted to a maintainer, who does not settle here, while GitHub answers.
    await drainCommands(w.db, { ...deps(w, { exec: gh.exec }), permission: async () => { await w.db.run(w.db.k.updateTable("access").set({ role: "maintainer" }).where("login", "=", OPERATOR)); return WRITE; } });
    assert.equal((await rows(w))[0]!.state, "refused");
    assert.equal(await preapprovalOf(w.db, "app", 1), null);
    assert.match(gh.posted[0]!.body, /@op Not added to the merge queue: only an operator, or a maintainer/);
    // The login is bound to another GitHub account while GitHub answers: no pre-approval and no answer.
    await w.db.run(w.db.k.updateTable("access").set({ role: "operator" }).where("login", "=", OPERATOR));
    await deliver(w, payload({ body: `@${SLUG} merge queue`, number: 2, comment: 9002 }));
    await w.db.run(w.db.k.deleteFrom("sync_requests"));
    await readAt(w, 2, new Date(Date.now() + 1000));
    await drainCommands(w.db, { ...deps(w, { exec: gh.exec }), permission: async () => { await w.db.run(w.db.k.updateTable("access").set({ github_id: 999 }).where("login", "=", OPERATOR)); return WRITE; } });
    assert.equal((await rows(w))[1]!.state, "ignored");
    assert.equal(await preapprovalOf(w.db, "app", 2), null);
    assert.equal(gh.posted.length, 1);
  });

  test("a command exactly an hour old has expired", async () => {
    const w = await (await fresh()).pr(1);
    await deliver(w, payload({ body: `@${SLUG} merge queue` }));
    const at = Date.parse((await w.db.get(w.db.k.selectFrom("github_commands").select("requested_at")))!.requested_at);
    await drained(w, { exec: ghFake().exec, now: () => new Date(at + 3600_000) });
    assert.deepEqual((await rows(w)).map((r) => r.state), ["expired"]);
    assert.equal(await preapprovalOf(w.db, "app", 1), null);
  });

  test("the hour can run out while GitHub answers the permission read: then nothing is queued", async () => {
    const w = await (await fresh()).pr(1);
    await deliver(w, payload({ body: `@${SLUG} merge queue` }));
    const gh = ghFake();
    // 59 minutes when the drain starts, 61 once the permission read is back.
    let at = Date.now() + 59 * 60_000;
    const permission = async () => { at = Date.now() + 61 * 60_000; return WRITE; };
    await w.db.run(w.db.k.deleteFrom("sync_requests"));
    await readAt(w, 1, new Date(Date.now() + 1000));
    await drainCommands(w.db, { ...deps(w, { exec: gh.exec, now: () => new Date(at) }), permission });
    assert.deepEqual((await rows(w)).map((r) => r.state), ["expired"]);
    assert.equal(await preapprovalOf(w.db, "app", 1), null);
    assert.equal(gh.posted.length, 0);
  });
});

describe("comment-time checks", () => {
  test("indented code and HTML comments, also across lines, hide a command", () => {
    const cmd = `@${SLUG} merge queue`;
    for (const body of ["    " + cmd, "\t" + cmd, "text\n\n    " + cmd, "<!--\n" + cmd + "\n-->", "<!-- " + cmd + " -->", "<!-- note\nstill hidden\n" + cmd])
      assert.equal(parseCommand(body, SLUG), null, body);
    for (const body of ["<!-- note -->\n" + cmd, "<!--\nhidden\n-->\n" + cmd, "   " + cmd]) assert.notEqual(parseCommand(body, SLUG), null, body);
  });

  test("a redelivered old comment, or one without a creation time, queues nothing", async () => {
    const w = await (await fresh()).pr(1);
    await deliver(w, payload({ body: `@${SLUG} merge queue`, created: new Date(Date.now() - STALE_MS - 1000) }));
    const p = payload({ body: `@${SLUG} merge queue`, comment: 5001 }) as { comment: { created_at?: string } };
    delete p.comment.created_at;
    await deliver(w, p);
    assert.deepEqual(await rows(w), []);
  });

  test("a deleted comment, another author or a body that no longer holds the command runs nothing and gets no answer", async () => {
    const w = await (await fresh()).pr(1);
    for (const c of [5001, 5002, 5003, 5004]) await deliver(w, payload({ body: `@${SLUG} merge queue`, comment: c }));
    const now: Record<number, CommentNow> = {
      5001: { kind: "gone" },
      5002: { kind: "ok", authorId: 999, body: `@${SLUG} merge queue` },
      5003: { kind: "ok", authorId: OP_ID, body: "never mind" },
      5004: { kind: "ok", authorId: OP_ID, body: `@${SLUG} merge queue 9` },
    };
    const gh = ghFake();
    await drained(w, { exec: gh.exec, comment: async (_repo, id) => now[id]! });
    assert.deepEqual((await rows(w)).map((r) => [r.state, r.reply]), [["ignored", "none"], ["ignored", "none"], ["ignored", "none"], ["ignored", "none"]]);
    assert.equal(gh.posted.length, 0);
    assert.equal(await preapprovalOf(w.db, "app", 1), null);
  });

  test("a PR pushed to after the comment, or whose mirror head is not GitHub's, is refused; the unchanged head is pre-approved", async () => {
    const w = await (await (await (await fresh()).pr(1)).pr(2)).pr(3);
    for (const n of [1, 2, 3]) await deliver(w, payload({ body: `@${SLUG} merge queue`, number: n, comment: 6000 + n }));
    const gh = ghFake();
    const head = async (n: number) => (await w.db.get(w.db.k.selectFrom("items").select("head_oid").$narrowType<{ head_oid: string }>().where("repo", "=", "app").where("number", "=", n)))!.head_oid;
    const pr = async (_q: unknown, _repo: string, n: number): Promise<PrNow> =>
      n === 1 ? { head: await head(1), opened: "2020-01-01T00:00:00Z", changed: true } : { head: n === 2 ? "f".repeat(40) : await head(3), opened: "2020-01-01T00:00:00Z", changed: false };
    await drained(w, { exec: gh.exec, pr });
    assert.deepEqual((await rows(w)).map((r) => r.state), ["refused", "refused", "done"]);
    for (const b of gh.posted.slice(0, 2).map((p) => p.body)) assert.match(b, /Not added to the merge queue: the PR changed after your comment; comment again\.$/);
    assert.equal(await preapprovalOf(w.db, "app", 1), null);
    assert.equal(await preapprovalOf(w.db, "app", 2), null);
    assert.equal((await preapprovalOf(w.db, "app", 3))?.head, await head(3));
  });

  test("on an issue, a closing PR opened or pushed to after the comment is named, not queued", async () => {
    const w = await (await (await fresh()).issue(3)).pr(4);
    await w.db.run(w.db.k.updateTable("items").set({ closing_issues: "[3]" }).where("repo", "=", "app").where("number", "=", 4));
    await deliver(w, payload({ body: `@${SLUG} merge queue`, number: 3, pr: false }));
    const gh = ghFake();
    await readAt(w, 4, new Date(Date.now() + 1000));
    const pr = async (): Promise<PrNow> => ({ head: "a".repeat(40), opened: new Date(Date.now() + 1000).toISOString(), changed: false });
    await drained(w, { exec: gh.exec, pr });
    assert.equal((await rows(w))[0]!.state, "done");
    assert.equal(await preapprovalOf(w.db, "app", 4), null);
    assert.deepEqual((await fastTrackList(w.db)).map((f) => f.number), [3]);
    assert.match(gh.posted[0]!.body, /#4 closes it but was opened or pushed to after your comment, so it was not queued; comment on #4 to queue it/);
  });

  test("an access GitHub cannot read is retried, and the command that expires that way is answered once", async () => {
    const w = await (await fresh()).pr(1);
    await deliver(w, payload({ body: `@${SLUG} merge queue` }));
    const gh = ghFake();
    await drained(w, { exec: gh.exec, permission: async () => ({ kind: "unavailable" }) });
    assert.equal((await rows(w))[0]!.state, "queued");
    await drained(w, { exec: gh.exec, now: () => new Date(Date.now() + 3600_000) });
    assert.deepEqual((await rows(w)).map((r) => [r.state, r.reply]), [["expired", "posted"]]);
    assert.match(gh.posted[0]!.body, /@op Not added to the merge queue: could not check your access; comment again\.$/);
    await drained(w, { exec: gh.exec, now: () => new Date(Date.now() + 3600_000) });
    assert.equal(gh.posted.length, 1);
  });

  test("mq lgtm queues with bypass checks; a plain command does not", async () => {
    const w = await (await (await fresh()).pr(1)).pr(2);
    await deliver(w, payload({ body: `@${SLUG} mq lgtm`, number: 1, comment: 5001 }));
    await deliver(w, payload({ body: `@${SLUG} merge queue`, number: 2, comment: 5002 }));
    await drained(w, { exec: ghFake().exec });
    assert.deepEqual((await rows(w)).map((r) => r.state), ["done", "done"]);
    const bypassOf = async (n: number) => (await w.db.get(w.db.k.selectFrom("preapprovals").select("bypass").where("number", "=", n)))?.bypass;
    assert.deepEqual([await bypassOf(1), await bypassOf(2)], [1, 0]);
  });

  test("a quiet PR: a maintainer's command is refused without an answer, an operator's is carried out without one", async () => {
    const w = await (await fresh()).pr(1);
    await w.db.run(w.db.k.insertInto("access").values({ login: "maint", role: "maintainer", github_id: 202 }));
    await w.db.run(w.db.k.insertInto("security_findings").values({ repo: "app", number: 1, scan_id: 1, area: "a", title: "t", severity: "high", state: "landing", refs: "[]", reach: "r", impact: "i", fingerprint: "f", fix_pr: 1, created_at: "2020-01-01T00:00:00Z", updated_at: "2020-01-01T00:00:00Z" }));
    await deliver(w, payload({ body: `@${SLUG} merge queue`, login: "maint", id: 202, comment: 5001 }));
    await deliver(w, payload({ body: `@${SLUG} merge queue`, comment: 5002 }));
    const gh = ghFake();
    await drained(w, { exec: gh.exec });
    assert.deepEqual((await rows(w)).map((r) => [r.state, r.reply]), [["refused", "none"], ["done", "none"]]);
    assert.equal(gh.posted.length, 0);
    assert.equal((await preapprovalOf(w.db, "app", 1))?.by, OPERATOR);
  });

  test("an unexpected error is answered with a fixed text; a refused person's answer needs the repo's comment approval", async () => {
    const w = await (await fresh(["comment"])).pr(1);
    await w.db.run(w.db.k.insertInto("access").values({ login: "maint", role: "maintainer", github_id: 202 }));
    await deliver(w, payload({ body: `@${SLUG} merge queue`, comment: 5001 }));
    await deliver(w, payload({ body: `@${SLUG} merge queue`, login: "maint", id: 202, comment: 5002 }));
    const gh = ghFake();
    await drained(w, { exec: gh.exec, queue: async () => { throw new Error("SQLITE_BUSY: database is locked"); } });
    assert.deepEqual((await rows(w)).map((r) => [r.state, r.result, r.reply]), [["refused", "it could not be queued", "posted"], ["refused", (await rows(w))[1]!.result, "failed"]]);
    assert.equal(gh.posted.length, 1);
    assert.match(gh.posted[0]!.body, /@op Not added to the merge queue: it could not be queued\.$/);
  });

  test("prSince sees a force push, a later commit or a later first check suite on the head; a head without a check suite is unknown", async () => {
    const since = "2026-01-01T12:00:00Z", before = "2026-01-01T11:00:00Z", after = "2026-01-01T13:00:00Z";
    const answer = (o: { push?: string; date?: string; suites?: string[] }) => validating({
      spent: 0, remaining: 5000,
      async query() {
        return { repository: { pullRequest: { createdAt: before, headRefOid: "h1", timelineItems: { nodes: o.push ? [{ createdAt: o.push }] : [] },
          commits: { nodes: [{ commit: { oid: "h0", committedDate: before, checkSuites: { nodes: [] } } }, { commit: { oid: "h1", committedDate: o.date ?? before, checkSuites: { nodes: (o.suites ?? []).map((createdAt) => ({ createdAt })) } } }] } } } };
      },
    });
    const changed = async (o: Parameters<typeof answer>[0]) => (await prSince(answer(o), "app", 1, since))?.changed;
    assert.equal(await changed({ suites: [before, after] }), false);
    await assert.rejects(changed({}), /no check suite/, "a back-dated push before CI registers it cannot be told from no push");
    assert.equal(await changed({ push: after }), true);
    assert.equal(await changed({ push: before, date: after }), true);
    assert.equal(await changed({ suites: [after] }), true);
    assert.deepEqual(await prSince(answer({ suites: [before] }), "app", 1, since), { head: "h1", opened: before, changed: false });
  });
});
