// Writes whose answer was lost: what the lookup on GitHub takes for the earlier write, and what an error says about a create.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { githubWide } from "../src/act/index.ts";
import type { Guarded, GuardedItem, GuardedRepo } from "../src/core/guard.ts";
import { issueMade } from "../src/github/made.ts";
import { commentOn, createIssue, ghAskComment, ghComment, IssueError, UnsettledError } from "../src/github/write.ts";
import { Client, Transient } from "../src/mirror.ts";
import { SCRATCH } from "./scratch.ts";
import { failsBegin } from "./helpers/fails-begin.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "lost-writes-"));
const note = { by: "fixed" } as const;
const url = (n: number) => `https://github.com/storytold/app/pull/3#issuecomment-${n}`;

/** GitHub's comments on one PR: `lose` makes the next comment without answering, `drop` neither makes nor answers it. */
function comments() {
  const on: { url: string; body: string; at: string }[] = [];
  const gh = { on, next: "ok" as "ok" | "lose" | "drop", exec: async (_cmd: string, args: string[], opts: { input?: string } = {}) => {
    if (args[0] === "api") return { code: 0, stdout: on.map((c) => JSON.stringify(c)).join("\n"), stderr: "" };
    const how = gh.next;
    gh.next = "ok";
    if (how !== "drop") on.push({ url: url(on.length + 1), body: String(opts.input), at: new Date().toISOString() });
    return how === "ok" ? { code: 0, stdout: `${url(on.length)}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "HTTP 502: Bad Gateway" };
  } };
  return gh;
}

test("an ask at a new head is posted after the same ask at an earlier head lost its answer; at the same head it is found", async () => {
  const db = await connectDb(join(dir, "head.db"));
  const gh = comments();
  const ask = (head: string) => ghAskComment({ db, login: "conflict" }, gh.exec, "conflict-comment", { scope: "pr", action: { kind: "conflict", bucket: "ask" }, repo: "app", number: 3, head, as: "app" } as unknown as Guarded<"conflict">, note, "merge main", { head });
  gh.next = "lose";
  assert.notEqual((await ask("a")).code, 0);
  assert.equal((await ask("b")).stdout.trim(), url(2));
  assert.equal((await ask("a")).stdout.trim(), url(1));
  assert.equal(gh.on.length, 2);
});

test("a comment recorded as another write's is not taken for the one whose answer was lost", async () => {
  const db = await connectDb(join(dir, "taken.db"));
  const gh = comments();
  const g = { scope: "item", action: { kind: "act" }, repo: "app", number: 3, as: "app" } as unknown as GuardedItem;
  const reply = (comment: number) => ghComment({ db, login: "op" }, g, gh.exec, "github-command-reply", { repo: "app", number: 3, pr: true }, note, "Done.", { comment });
  await reply(1);
  gh.next = "drop";
  assert.notEqual((await reply(2)).code, 0);
  assert.equal((await reply(2)).stdout.trim(), url(2));

  const q = { spent: 0, remaining: 5000, async query(text: string) {
    if (text.startsWith("mutation")) throw new Error("timeout");
    return { node: { comments: { nodes: gh.on.map((c) => ({ url: c.url, body: c.body, createdAt: c.at, author: { login: "bot" } })) } } };
  } };
  const on = (action: number) => commentOn({ db, login: "op" }, g, q, "act-comment", { repo: "app", number: 3, id: "I3" }, note, "Done.", { action });
  await assert.rejects(on(1), /timeout/);
  await assert.rejects(on(1), /timeout/, "none of the comments there is this write's");
});

test("a lost issue is found by its title or body under our own name, reading no further than the time of the try", async () => {
  const day = (d: number) => new Date(Date.UTC(2026, 0, d)).toISOString();
  const issue = (number: number, title: string, body: string, by: string, at: string) => ({ number, url: `https://github.com/storytold/app/issues/${number}`, title, body, by, at, pr: false });
  let pages = 0;
  const find = (first: ReturnType<typeof issue>[]) => {
    pages = 0;
    return issueMade(async () => { pages++; return [...first, ...Array.from({ length: 100 - first.length }, (_, k) => issue(1 + k, "older", "older", "us", day(pages === 1 && k < 50 ? 12 : 8)))].map((r) => JSON.stringify(r)).join("\n"); },
      { repo: "app", title: "Crash", body: "It crashes.", since: day(10), mine: (l) => l === "us", taken: new Set(["https://github.com/storytold/app/issues/95"]) });
  };
  assert.equal((await find([issue(99, "Crash", "It crashes.", "someone", day(12)), issue(98, "Crash on open", "It crashes.", "us", day(12))]))?.number, 98);
  assert.equal((await find([issue(97, "Crash", "It crashes when opened.", "us", day(12)), issue(95, "Crash", "It crashes.", "us", day(12))]))?.number, 97);
  assert.equal(await find([issue(96, "Crash", "It crashes.", "us", day(9))]), null);
  assert.equal(pages, 1, "the first page reaches back past the try");
});

test("a create whose audit row could not be finished may have made the issue; one a rate limit refused made none and may be tried again", async () => {
  const g = { scope: "repo", repo: "app", as: "app" } as unknown as GuardedRepo;
  const create = async (exec: Parameters<typeof createIssue>[2], db: Awaited<ReturnType<typeof connectDb>>) =>
    await createIssue({ db, login: "x" }, g, exec, { repo: "app", target: "app#3", title: "t", body: "b" }, note).then(() => null, (e: IssueError) => ({ clear: e.clear, later: e.later }));
  const gone = await connectDb(join(dir, "gone.db"));
  assert.deepEqual(await create(async () => { await gone.close(); return { code: 0, stdout: "https://github.com/storytold/app/issues/4\n", stderr: "" }; }, gone), { clear: false, later: false });
  const db = await connectDb(join(dir, "limit.db"));
  assert.deepEqual(await create(async () => ({ code: 1, stdout: "", stderr: "GraphQL: API rate limit already exceeded for user ID 1." }), db), { clear: true, later: true });
});

test("a create that failed before its request sent nothing, unless an earlier try may have made the issue", async () => {
  const g = { scope: "repo", repo: "app", as: "app" } as unknown as GuardedRepo;
  let creates = 0;
  const create = async (db: Awaited<ReturnType<typeof connectDb>>, exec: Parameters<typeof createIssue>[2] = async () => { creates++; return { code: 1, stdout: "", stderr: "timeout" }; }) =>
    await createIssue({ db, login: "x" }, g, exec, { repo: "app", target: "app#3", title: "t", body: "b" }, note).then(() => null, (e: IssueError) => [e.clear, e.later, e.unsent, e.unsettled]);
  const db = await connectDb(join(dir, "before.db"));
  assert.deepEqual([await create(failsBegin(db)), creates], [[true, true, true, false], 0]);
  assert.deepEqual([await create(db), creates], [[false, false, false, false], 1], "this request went out");
  assert.deepEqual([await create(db, async () => { throw new Error("no network"); }), creates], [[false, false, false, true], 1], "GitHub cannot be read for the lost try");
});

test("comments that speak of abuse are not a rate limit of GitHub", async () => {
  const bin = (name: string, body: string) => { const d = mkdtempSync(join(dir, name)); writeFileSync(join(d, "gh"), `#!/bin/sh\ncat >/dev/null\n${body}\n`); chmodSync(join(d, "gh"), 0o755); return new Client(0, { PATH: `${d}:${process.env.PATH}` }); };
  const ok = bin("ok", `echo '{"data":{"node":{"comments":{"nodes":[{"body":"abuse of the secondary rate limit"}]}}}}'`);
  assert.equal((await ok.query("query { node }", { owner: "storytold" })).node.comments.nodes.length, 1);
});

test("a lookup that failed because GitHub is failing stops the closes without counting a try", () => {
  assert.equal(githubWide(new UnsettledError("may have been made: secondary", { cause: new Transient("secondary") })), true);
  assert.equal(githubWide(new UnsettledError("may have been made: Could not resolve to a node", { cause: new Error("Could not resolve to a node") })), false);
});
