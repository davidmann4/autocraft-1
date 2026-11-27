import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, untilCutoff } from "../src/mirror.ts";
import { validating } from "./gql.ts";

const page = (...times: string[]) => times.map((updatedAt) => ({ updatedAt }));

test("incremental sync stops at the first old item and requests no further page", async () => {
  let fetched = 0;
  async function* pages() {
    for (const p of [page("2026-02", "2026-01"), page("2025-12"), page("2025-11")]) {
      fetched++;
      yield p;
    }
  }
  const out: string[][] = [];
  for await (const p of untilCutoff(pages(), "2026-01")) out.push(p.map((n) => n.updatedAt));
  assert.deepEqual(out, [["2026-02", "2026-01"]]);
  assert.equal(fetched, 2);
});


// ---- search-based incremental sync ----
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { reconcileRepo, runSync } from "../src/mirror.ts";
import { itemText, textHash } from "../src/embed/text.ts";
import { inputHash } from "../src/runner/classify.ts";
import { SCRATCH } from "./scratch.ts";
import { saveSyncState, loadSyncState } from "../src/data/mirror/index.ts";

const node = (repo: string, number: number, state = "OPEN", updatedAt = "2026-11-02T10:00:00Z") => ({
  __typename: "Issue", repository: { name: repo }, number, title: `t${number}`, body: "", url: "u", author: { login: "a" },
  authorAssociation: "NONE", createdAt: "2026-01-01T00:00:00Z", updatedAt, closedAt: null, state,
  labels: { nodes: [] }, assignees: { nodes: [] }, commentCount: { totalCount: 0 }, stateReason: null,
  comments: { nodes: [] },
});

function fakeClient(nodes: unknown[], issueCount = nodes.length, failAfter = Infinity) {
  const c = validating({
    spent: 0, remaining: 4000 as number | null, calls: [] as { query: string; variables: Record<string, unknown> }[],
    async query(query: string, variables: Record<string, unknown>) {
      c.calls.push({ query, variables });
      if (c.calls.length > failAfter) throw new Error("boom");
      return { search: { issueCount, pageInfo: { hasNextPage: false, endCursor: null }, nodes } };
    },
  });
  return c;
}

async function scratch() {
  const dir = mkdtempSync(join(SCRATCH, "fastsync-"));
  const db = await connectDb(join(dir, "m.db"));
  await db.run(db.k.deleteFrom("tracked_repos"));
  await db.run(db.k.insertInto("tracked_repos").values(["a", "b"].map((name) => ({ name, added_by: "t", added_at: "x", pipeline: 1 }))));
  const seen = "2026-11-02T09:00:00Z";
  await db.run(db.k.insertInto("repos").values(["a", "b"].map((name) => ({ name, synced_at: seen, high_water: seen, reconciled_at: seen }))));
  await saveSyncState(db, { org_high_water: "2026-11-02T09:30:00Z", repos_refreshed_at: "2999-01-01T00:00:00Z", search_catchup_at: "2999-01-01T00:00:00Z" });
  return { dir, db };
}
const opts = { only: [], all: false, full: false, perRepo: false };
const hw = async (db: Db) => (await loadSyncState(db)).org_high_water;


test("search mode writes tracked results, ignores untracked, advances the high water", async () => {
  const { db } = await scratch();
  const c = fakeClient([node("a", 1), node("zzz", 2), node("b", 3, "CLOSED")]);
  const r = await runSync(db, c, opts, new Date("2026-11-02T10:05:00Z"));
  assert.deepEqual(r, { mode: "search", items: 2 });
  assert.equal(c.calls.length, 1);
  assert.match(String(c.calls[0].variables.q), /updated:2026-11-02T09:20:00Z\.\.2026-11-02T10:05:00Z/);
  const rows = await db.all(db.k.selectFrom("items").select(["repo", "number", "detail_level"]).orderBy("number"));
  assert.deepEqual(rows.map((x) => ({ ...x })), [{ repo: "a", number: 1, detail_level: "full" }, { repo: "b", number: 3, detail_level: "light" }]);
  assert.equal(await hw(db), "2026-11-02T10:00:00Z", "the high water is the newest updatedAt, not the start time");
  const at = (await db.all(db.k.selectFrom("repos").select(["name", "synced_at"]).orderBy("name"))).map((x) => ({ ...x }));
  assert.deepEqual(at, [{ name: "a", synced_at: "2026-11-02T10:05:00Z" }, { name: "b", synced_at: "2026-11-02T10:05:00Z" }], "every tracked repo counts as synced");
});

// A fake search over `all`: honours `updated:A..B` and the updatedAt sort on the index time (`indexedAt`, else
// `updatedAt`), pages by cursor, and reports the true match count.
type Indexed = ReturnType<typeof node> & { indexedAt?: string };
const indexTime = (n: Indexed) => n.indexedAt ?? n.updatedAt;
function searchClient(all: Indexed[]) {
  const c = validating({
    spent: 0, remaining: 4000 as number | null, queries: [] as string[], windows: [] as { from: string; to: string; matches: number }[],
    async query(query: string, v: Record<string, unknown>) {
      c.queries.push(query);
      assert.ok(query.includes("search("), "only search queries are expected");
      const m = /updated:(\S+)\.\.(\S+)/.exec(String(v.q))!;
      const hits = all.filter((n) => indexTime(n) >= m[1] && indexTime(n) <= m[2]);
      if (/ sort:updated-asc\b/.test(String(v.q))) hits.sort((x, y) => indexTime(x).localeCompare(indexTime(y)));
      const start = Number(v.after ?? 0), size = Number(v.first);
      if (!v.after) c.windows.push({ from: m[1], to: m[2], matches: hits.length });
      const end = Math.min(start + size, 1000, hits.length);
      return { search: { issueCount: hits.length, pageInfo: { hasNextPage: end < Math.min(1000, hits.length), endCursor: String(end) }, nodes: hits.slice(start, end) } };
    },
  });
  return c;
}
const at = (sec: number) => new Date(Date.UTC(2026, 10, 2, 10, 0, 0) + sec * 1000).toISOString().replace(".000Z", "Z");

test("a window with more than 1,000 matches is split into slices; nothing falls back to per-repo passes", async () => {
  const { db } = await scratch();
  const all = Array.from({ length: 2500 }, (_, i) => node(i % 2 ? "a" : "b", i + 1, "OPEN", at(i % 1200)));
  const c = searchClient(all);
  const r = await runSync(db, c, opts, new Date("2026-11-02T10:30:00Z"));
  assert.equal(r.mode, "search");
  assert.equal(r.items, 2500);
  assert.equal((await db.get(db.k.selectFrom("items").select((eb) => eb.fn.countAll<number>().as("n"))))!.n, 2500);
  assert.ok(c.queries.every((q) => q.includes("search(")), "no per-repo query");
  const leaves = c.windows.filter((w) => w.matches <= 1000);
  assert.ok(leaves.length >= 3, "split until each slice fits");
  assert.ok(c.windows.length > leaves.length, "over-cap windows were probed and cut");
  assert.equal(await hw(db), at(1199));
});




test("a search run stopped mid-way keeps the pages it stored, and the high water passes no unstored item", async () => {
  const { db } = await scratch();
  // Three items per second, so equal times straddle page boundaries; listed out of order, the search sorts them.
  const all: Indexed[] = Array.from({ length: 70 }, (_, i) => node(i % 2 ? "a" : "b", i + 1, i % 3 ? "OPEN" : "CLOSED", at(Math.floor(i / 3) * 5))).reverse();
  // The last item of the first page changed just now, and the index still sorts it at its old time.
  const ahead = [...all].sort((x, y) => x.updatedAt.localeCompare(y.updatedAt))[19];
  ahead.indexedAt = ahead.updatedAt;
  ahead.updatedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const c = searchClient(all);
  const query = c.query;
  let calls = 0;
  c.query = async (q, v) => { if (++calls === 3) throw new Error("stopped"); return query(q, v); };
  await assert.rejects(runSync(db, c, opts, new Date("2026-11-02T10:30:00Z")), /stopped/);
  const stored = new Set((await db.all(db.k.selectFrom("items").select("number"))).map((r) => Number(r.number)));
  const mark = (await hw(db))!;
  assert.ok(stored.size > 0 && stored.size < all.length);
  assert.ok(mark > "2026-11-02T09:30:00Z", "the high water moved with the stored pages");
  assert.ok(all.every((n) => stored.has(n.number) || n.updatedAt >= mark), "every item before the high water is stored");

  const again = searchClient(all);
  await runSync(db, again, opts, new Date("2026-11-02T10:31:00Z"));
  assert.ok(again.windows[0].from > "2026-11-02T09:20:00Z", "the next run starts from the kept high water");
  assert.equal((await db.all(db.k.selectFrom("items").select("number"))).length, all.length);
});

test("sync stores the text hashes the planner compares", async () => {
  const { db } = await scratch();
  const n = { ...node("a", 1), title: "Crash on open", body: "<!-- t -->See [docs](http://x.y) now\n```\ncode\n```" };
  await runSync(db, fakeClient([n]), opts, new Date("2026-11-02T10:05:00Z"));
  const row = (await db.get(db.k.selectFrom("items").select(["embed_hash", "class_hash"]).where("number", "=", 1)))!;
  assert.equal(row.embed_hash, textHash(itemText(n.title, n.body)));
  assert.equal(row.class_hash, inputHash({ repo: "a", number: 1, kind: "issue", title: n.title, body: n.body, lines_changed: null, files_changed: null, author_association: "NONE" }));
  const { pending } = await import("../src/embed/store.ts");
  assert.equal((await pending(db, "m")).length, 1);
  await db.run(db.k.insertInto("item_embeddings").values({ repo: "a", number: 1, model: "m", hash: row.embed_hash!, vec: new Uint8Array([0]), at: "x" }));
  assert.equal((await pending(db, "m")).length, 0);
  assert.equal((await pending(db, "other")).length, 1);
  await db.run(db.k.updateTable("items").set({ embed_hash: null }).where("number", "=", 1)); // legacy row: planning reads the hash from the text and writes nothing
  assert.equal((await pending(db, "m")).length, 0);
  assert.equal((await db.get(db.k.selectFrom("items").select("embed_hash").where("number", "=", 1)))!.embed_hash, null);
  const { fillEmbedHashes } = await import("../src/itemhash.ts");
  assert.equal(await fillEmbedHashes(db), 1); // the embed and dupes jobs fill it
  assert.equal((await db.get(db.k.selectFrom("items").select("embed_hash").where("number", "=", 1)))!.embed_hash, row.embed_hash);
  await db.run(db.k.updateTable("items").set({ body: "new text" }).where("number", "=", 1)); // an edit outside sync clears the hashes
  assert.equal((await pending(db, "m")).length, 1);
});








test("a reconcile keeps what it read before a read that fails, and a re-read item the mirror refuses costs no other", async () => {
  const { db } = await scratch();
  await db.run(db.k.insertInto("items").values([1, 2, 3, 4].map((number) => ({ repo: "a", number, kind: "issue", state: "OPEN", title: "t", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }))));
  const reads: number[] = [];
  const run = (read: (n: number) => unknown) => reconcileRepo(db, { spent: 0, remaining: 4000, async query(q: string, v: Record<string, unknown>) {
    if (q.includes("issueOrPullRequest")) { reads.push(v.number as number); return { repository: { issueOrPullRequest: read(v.number as number) } }; }
    return { repository: { items: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }, issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }, pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
  } }, "a");
  const states = async () => (await db.all(db.k.selectFrom("items").select(["number", "state"]).where("repo", "=", "a").orderBy("number"))).map((r) => r.state);
  await assert.rejects(run((n) => { if (n === 3) throw new Error("boom"); return n === 1 ? null : node("a", n, "CLOSED"); }), /boom/);
  assert.deepEqual(reads, [1, 2, 3]);
  assert.deepEqual(await states(), ["CLOSED", "CLOSED", "OPEN", "OPEN"], "the gone item and the closed one before the failure are stored");
  await assert.rejects(run((n) => ({ ...node("a", n, "CLOSED"), ...(n === 3 && { createdAt: null, updatedAt: null, state: null }) })));
  assert.deepEqual(await states(), ["CLOSED", "CLOSED", "OPEN", "CLOSED"]);
});

test("a deleted item reads as null; a missing repository still fails", async () => {
  const c = new Client(0);
  const answer = (data: unknown) => () => ({ data, errors: [{ type: "NOT_FOUND", message: "Could not resolve to an issue or pull request with the number of 2401." }], text: "", failed: true, stderr: "gh: Could not resolve" });
  (c as unknown as { run: unknown }).run = answer({ rateLimit: { cost: 1, remaining: 4000, resetAt: "2026-11-04T15:00:00Z" }, repository: { issueOrPullRequest: null } });
  assert.equal((await c.query("q", {})).repository.issueOrPullRequest, null);
  (c as unknown as { run: unknown }).run = answer({ repository: null });
  await assert.rejects(c.query("q", {}));
});

test("search results GitHub refuses for lack of access are dropped; other errors still fail", async () => {
  const c = new Client(0);
  const answer = (errors: unknown[]) => () => ({
    data: { rateLimit: { cost: 1, remaining: 4000, resetAt: "2026-11-09T15:00:00Z" }, search: { nodes: [{ number: 1 }, null], pageInfo: { hasNextPage: false } } },
    errors, text: "", failed: true, stderr: "gh: Resource not accessible by integration",
  });
  (c as unknown as { run: unknown }).run = answer([{ type: "FORBIDDEN", path: ["search", "nodes", 1], message: "Resource not accessible by integration" }]);
  assert.deepEqual((await c.query("q", {})).search.nodes, [{ number: 1 }, null]);
  (c as unknown as { run: unknown }).run = answer([{ type: "FORBIDDEN", path: ["search", "nodes", 0, "author"], message: "Resource not accessible by integration" }]);
  assert.deepEqual((await c.query("q", {})).search.nodes, [null, null]);
  (c as unknown as { run: unknown }).run = answer([{ type: "FORBIDDEN", path: ["rateLimit"], message: "Resource not accessible by integration" }]);
  await assert.rejects(c.query("q", {}));
});

// ---- mergeable keeps its known value at one head ----
import { tmpdir } from "node:os";
import { saveChecks, type PrChecks } from "../src/review/checks.ts";
import { connectDb, type Db } from "./helpers/raw-db.ts";

test("saveChecks keeps a known mergeable at the same head and replaces it at a new head", async () => {
  const db = await connectDb(join(mkdtempSync(join(tmpdir(), "mergeable-")), "t.db"));
  const save = async (head: string, mergeable: string) => await saveChecks(db, [{ repo: "app", number: 7, head_oid: head, state: "OPEN", is_draft: false, overall: "success", checks: [], mergeable, maintainer_can_modify: true }]);
  const stored = async () => (await db.get(db.k.selectFrom("pr_checks").select("mergeable").where("repo", "=", "app").where("number", "=", 7)))!.mergeable;
  await save("h1", "CONFLICTING");
  await save("h1", "UNKNOWN");
  assert.equal(await stored(), "CONFLICTING");
  await save("h1", "MERGEABLE");
  assert.equal(await stored(), "MERGEABLE");
  await save("h2", "UNKNOWN");
  assert.equal(await stored(), "UNKNOWN");
});

test("saveChecks of many PRs records waiting runs, settles pushes and follows unknown merge states, and the reread marks a PR stuck", async () => {
  const { rereadUnknown, unknownOf, READS_BEFORE_REQUEST } = await import("../src/merge/mergeable.ts");
  const db = await connectDb(join(mkdtempSync(join(tmpdir(), "checks-many-")), "t.db"));
  const at = "2026-11-01T00:00:00Z";
  const prs = Array.from({ length: 30 }, (_, i) => i + 1);
  for (const n of prs) await db.run(db.k.insertInto("items").values({ repo: "app", number: n, kind: "pr", state: n === 30 ? "CLOSED" : "OPEN", title: "t", author: "a", head_oid: `h${n}`, created_at: at, updated_at: at }));
  // #3 and #4 are reviewed take at their heads.
  for (const n of [3, 4]) await db.run(db.k.insertInto("opus_reviews").values({ repo: "app", number: n, head_oid: `h${n}`, at, model: "opus", mode: "full", verdict: "take", sure: 1, reason: "r", seen_at: at }));
  await db.run(db.k.insertInto("push_outcomes").values({ at: new Date().toISOString(), stage: "fixup", action: "fixup-push", repo: "app", number: 5, from_oid: "old", to_oid: "h5", before_res: "green" }));
  const row = (n: number): PrChecks => ({
    repo: "app", number: n, head_oid: `h${n}`, state: "OPEN", is_draft: false, overall: n === 5 ? "failure" : "success", checks: [{ name: "gate", state: n === 5 ? "failure" : "success" }],
    mergeable: n === 3 ? "UNKNOWN" : "MERGEABLE", maintainer_can_modify: true,
    suites: n === 2 ? [{ id: 77, name: "ci", event: "pull_request", status: "COMPLETED", conclusion: "ACTION_REQUIRED" }] : [],
  });
  const save = async () => await saveChecks(db, prs.slice(0, 29).map(row));
  for (let i = 0; i < READS_BEFORE_REQUEST; i++) await save();
  assert.equal((await db.all(db.k.selectFrom("pr_checks").select("number").where("repo", "=", "app"))).length, 29);
  const runs = await db.all(db.k.selectFrom("ci_run_approvals").select(["number", "runs"]));
  assert.deepEqual(runs.map((r) => [r.number, (JSON.parse(r.runs) as { id: number }[]).map((x) => x.id)]), [[2, [77]]], "only the PR with a run held for approval gets a row");
  assert.equal((await db.get(db.k.selectFrom("push_outcomes").select("outcome").where("to_oid", "=", "h5")))!.outcome, "broke");
  assert.equal((await unknownOf(db, "app", 3, "h3"))?.reads, READS_BEFORE_REQUEST, "each read of the unknown state counts");
  assert.equal(await unknownOf(db, "app", 4, "h4"), null, "a known state is not followed");
  // A note left for a closed PR goes; the unknown one is requested and, with no answer, marked stuck.
  await db.run(db.k.insertInto("merge_state").values({ repo: "app", number: 30, head: "h30", since: at, reads: 9, rereads: 0, stuck: 0 }));
  const asked: number[] = [];
  const done = await rereadUnknown(db, { query: async () => { throw new Error("no GitHub read expected"); } } as never, "app", () => {}, async (_repo, n) => { asked.push(n); return null; });
  assert.deepEqual([done, asked], [[3], [3]]);
  assert.equal((await unknownOf(db, "app", 3, "h3"))?.stuck, true);
  assert.equal(await db.get(db.k.selectFrom("merge_state").select("number").where("repo", "=", "app").where("number", "=", 30)), undefined);
  // GitHub now reports #3 as mergeable: the note goes.
  await saveChecks(db, [{ ...row(3), mergeable: "MERGEABLE" }]);
  assert.equal(await unknownOf(db, "app", 3, "h3"), null);
  // A failing query still stores the rows the earlier queries read.
  const { refreshChecks, CHECKS_PER_QUERY } = await import("../src/review/checks.ts");
  let queries = 0;
  const failing = { query: async (q: string) => {
    if (queries++) throw new Error("GitHub is down");
    const nums = [...q.matchAll(/pullRequest\(number: (\d+)\)/g)].map((m) => Number(m[1]));
    return { repository: Object.fromEntries(nums.map((n) => [`pr${n}`, { number: n, state: "OPEN", isDraft: false, headRefOid: "new", mergeable: "MERGEABLE", maintainerCanModify: true }])) };
  } };
  const many = Array.from({ length: CHECKS_PER_QUERY + 1 }, (_, i) => 101 + i);
  await assert.rejects(refreshChecks(db, failing as never, "app", many), /GitHub is down/);
  assert.equal((await db.all(db.k.selectFrom("pr_checks").select("number").where("head_oid", "=", "new"))).length, CHECKS_PER_QUERY);
});

test("the open-PR references follow an edit of the PR's text, from sync and from any other writer", async () => {
  const { writeItemNode } = await import("../src/mirror.ts");
  const { issuesWithOpenPr } = await import("../src/core/open-prs.ts");
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "refs-")), "m.db"));
  const pr = (body: string) => ({
    __typename: "PullRequest", repository: { name: "a", owner: { login: "storytold" } }, number: 7, title: "Change", body, url: "https://github.com/storytold/a/pull/7",
    author: { __typename: "User", login: "x", databaseId: 1 }, authorAssociation: "NONE", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-11-02T10:00:00Z", closedAt: null, state: "OPEN",
    labels: { nodes: [] }, assignees: { nodes: [] }, commentCount: { totalCount: 0 }, comments: { nodes: [] }, reviews: { nodes: [] },
    isDraft: false, mergedAt: null, mergedBy: null, additions: 1, deletions: 0, changedFiles: 1, headRefName: "b", headRefOid: "h1", headRepository: { nameWithOwner: "storytold/a" },
    baseRefName: "main", closingIssuesReferences: { nodes: [] }, maintainerCanModify: true, mergeable: "MERGEABLE", reviewDecision: null, commits: { nodes: [] },
  });
  await writeItemNode(db, "a", pr("Fixes #5"));
  assert.deepEqual((await issuesWithOpenPr(db, "a")).get(5), { number: 7, closes: true });
  await writeItemNode(db, "a", pr("Unrelated to #5 after all"));
  assert.deepEqual((await issuesWithOpenPr(db, "a")).get(5), { number: 7, closes: false });
  await writeItemNode(db, "a", pr("No references"));
  assert.equal((await issuesWithOpenPr(db, "a")).has(5), false);
  // Stored by sync, so the next edit must clear it.
  assert.notEqual((await db.get(db.k.selectFrom("items").select("text_refs").where("repo", "=", "a").where("number", "=", 7)))!.text_refs, null);
  await db.run(db.k.updateTable("items").set({ body: "Closes #6" }).where("repo", "=", "a").where("number", "=", 7));
  assert.deepEqual((await issuesWithOpenPr(db, "a")).get(6), { number: 7, closes: true });
});
