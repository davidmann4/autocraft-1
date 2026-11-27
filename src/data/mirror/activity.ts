// Item trace data: events, files, commits (M02 mirror-b).
// reads: control.tracked_repos
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import { trackedRepo } from "../control/fragments.ts";
import { loadItems } from "./items.ts";
import { loadComments } from "./comments.ts";
import { loadChecks } from "./checks.ts";
import { loadItemReads } from "./sync.ts";
import type { ActivityAttempt, ActivityDue, ActivityRead, ActivityRow, ActivityStats, CommitRow, FileRow, ItemDetail, ItemDetailPart, RefKey } from "./types.ts";

const refKey = (repo: string, number: number): RefKey => `${repo}#${number}`;
const group = <T extends { repo: string; number: number }>(rows: T[]): Map<RefKey, T[]> => {
  const out = new Map<RefKey, T[]>();
  for (const r of rows) (out.get(refKey(r.repo, Number(r.number))) ?? out.set(refKey(r.repo, Number(r.number)), []).get(refKey(r.repo, Number(r.number)))!).push(r);
  return out;
};
const onKeys = (alias: string) => (j: any) => j.onRef("kk.repo", "=", `${alias}.repo`).onRef("kk.number", "=", `${alias}.number`);

/**
 * Tracked items whose head or update time moved since their last read, and those whose failed read is past its retry time, newest
 * update first. Open items, and closed ones updated since `since`.
 */
export async function listActivityDue(db: Db, f: { since: string; now: string; limit: number }): Promise<ActivityDue[]> {
  const q = queryDb(db);
  return await q.all(q.k.selectFrom("main.items as i")
    .leftJoin("main.activity_sync as s", (j) => j.onRef("s.repo", "=", "i.repo").onRef("s.number", "=", "i.number"))
    .select(["i.repo", "i.number", "i.head_oid as head", "i.updated_at"])
    .where((eb) => eb.and([
      trackedRepo(eb, "i.repo"),
      eb.or([eb("i.state", "=", "OPEN"), eb("i.updated_at", ">=", f.since)]),
      eb.or([
        eb("s.repo", "is", null),
        eb("s.head", "is distinct from", eb.ref("i.head_oid")),
        eb("s.updated_at", "is distinct from", eb.ref("i.updated_at")),
        eb.and([eb("s.retry_at", "is not", null), eb("s.retry_at", "<=", f.now)]),
      ]),
    ]))
    // SQLite's order for DESC; Postgres would put NULLs first.
    .orderBy("i.updated_at", (o) => o.desc().nullsLast()).orderBy("i.repo").orderBy("i.number")
    .limit(Math.floor(f.limit)));
}

/**
 * One `db.write` for a pass: events, a PR's files (the old rows of the PR go first) and commits, and the `activity_sync` mark of
 * every read and attempt. A successful read clears the error and retry time of an earlier failed one (every column is written).
 * The later row of a key in the call wins.
 */
export async function saveActivity(db: Db, o: { reads: ActivityRead[]; attempts: ActivityAttempt[] }): Promise<void> {
  if (!o.reads.length && !o.attempts.length) return;
  const events = new Map<string, Record<string, unknown>>();
  const files = new Map<string, Record<string, unknown>>();
  const commits = new Map<string, Record<string, unknown>>();
  const sync = new Map<RefKey, Record<string, unknown>>();
  const prs: string[] = [];
  for (const r of o.reads) {
    const base = { repo: r.repo, number: r.number };
    for (const e of r.events) events.set(`${r.repo}\0${r.number}\0${e.id}`, { ...base, id: e.id, kind: e.kind, at: e.at, actor: e.actor, label: e.label, before_oid: e.before_oid, after_oid: e.after_oid });
    if (r.pr) {
      prs.push(refKey(r.repo, r.number));
      for (const f of r.pr.files) files.set(`${r.repo}\0${r.number}\0${r.pr.head}\0${f.path}`, { ...base, head: r.pr.head, path: f.path, additions: f.additions, deletions: f.deletions, change_type: f.change_type });
      for (const c of r.pr.commits) commits.set(`${r.repo}\0${r.number}\0${c.oid}`, { ...base, oid: c.oid, committed_at: c.committed_at, author: c.author, first_seen_at: r.readAt, message: c.message, co_authors: c.co_authors });
    }
    sync.set(refKey(r.repo, r.number), { ...base, head: r.head, updated_at: r.updatedAt, read_at: r.readAt, error: null, retry_at: null });
  }
  for (const a of o.attempts) {
    sync.set(refKey(a.repo, a.number), { repo: a.repo, number: a.number, head: a.head, updated_at: a.updatedAt, read_at: a.at, error: a.error ?? null, retry_at: a.retryAt ?? null });
  }
  const q = queryDb(db);
  const k = q.k as any;
  await db.write(async () => {
    for (const part of kx.batches([...events.values()])) {
      await q.run(k.insertInto("main.item_activity").values(part).onConflict((oc: any) => oc.columns(["repo", "number", "id"]).doUpdateSet(kx.excluded(["kind", "at", "actor", "label", "before_oid", "after_oid"]))));
    }
    if (prs.length) for (const part of kx.chunks(prs)) await q.run(q.k.deleteFrom("main.pr_files").where(kx.refIn(db, "pr_files", part)));
    for (const part of kx.batches([...files.values()])) {
      await q.run(k.insertInto("main.pr_files").values(part).onConflict((oc: any) => oc.columns(["repo", "number", "head", "path"]).doUpdateSet(kx.excluded(["additions", "deletions", "change_type"]))));
    }
    for (const part of kx.batches([...commits.values()])) {
      await q.run(k.insertInto("main.pr_commits").values(part).onConflict((oc: any) => oc.columns(["repo", "number", "oid"]).doUpdateSet((eb: any) => ({
        committed_at: eb.ref("excluded.committed_at"), author: eb.ref("excluded.author"),
        message: eb.fn.coalesce("excluded.message", "main.pr_commits.message"), co_authors: eb.fn.coalesce("excluded.co_authors", "main.pr_commits.co_authors"),
      }))));
    }
    for (const part of kx.batches([...sync.values()])) {
      await q.run(k.insertInto("main.activity_sync").values(part).onConflict((oc: any) => oc.columns(["repo", "number"]).doUpdateSet(kx.excluded(["head", "updated_at", "read_at", "error", "retry_at"]))));
    }
  });
}

/** Events ordered by id; `kinds` narrows them. */
export async function loadActivity(db: Db, keys: KeySource, o: { kinds?: string[] } = {}): Promise<Map<RefKey, ActivityRow[]>> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.item_activity as a").innerJoin(resolveKeys(db, keys, "kk"), onKeys("a"))
    .select(kx.cols("item_activity", "a")).$if(!!o.kinds, (b) => b.where(kx.inList(db, "a.kind", o.kinds!))).orderBy("a.id"));
  return group(rows);
}

/** Commits of each PR by commit time (the earlier of the commit and first-seen times), then oid. */
export async function loadCommits(db: Db, keys: KeySource): Promise<Map<RefKey, CommitRow[]>> {
  const q = queryDb(db);
  const at = (eb: kx.AnyEb) => kx.least<string>(db, ["c.committed_at", eb.fn.coalesce("c.first_seen_at", "c.committed_at")], "text");
  const rows = await q.all(q.k.selectFrom("main.pr_commits as c").innerJoin(resolveKeys(db, keys, "kk"), onKeys("c"))
    .select(kx.cols("pr_commits", "c")).orderBy((eb) => at(eb)).orderBy("c.oid"));
  return group(rows);
}

/** Files at the item's current head, by path. */
export async function loadFiles(db: Db, keys: KeySource): Promise<Map<RefKey, FileRow[]>> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.pr_files as f").innerJoin(resolveKeys(db, keys, "kk"), onKeys("f"))
    .innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "f.repo").onRef("i.number", "=", "f.number").onRef("i.head_oid", "=", "f.head"))
    .select(kx.cols("pr_files", "f")).orderBy("f.repo").orderBy("f.number").orderBy("f.path"));
  return group(rows);
}

/** Event, commit and file counts and the newest times for each key that has any; one statement. */
export async function loadActivityStats(db: Db, keys: KeySource): Promise<Map<RefKey, ActivityStats>> {
  const q = queryDb(db);
  const k = q.k;
  const joined = (alias: string, ka: string) => (j: any) => j.onRef(`${ka}.repo`, "=", `${alias}.repo`).onRef(`${ka}.number`, "=", `${alias}.number`);
  const events = k.selectFrom("main.item_activity as a").innerJoin(resolveKeys(db, keys, "k1"), joined("a", "k1"))
    .select((eb) => ["a.repo", "a.number", eb.fn.countAll<number>().as("n"), eb.fn.max<string | null>("a.at").as("newest")]).groupBy(["a.repo", "a.number"]).as("ev");
  const commits = k.selectFrom("main.pr_commits as c").innerJoin(resolveKeys(db, keys, "k2"), joined("c", "k2"))
    .select((eb) => ["c.repo", "c.number", eb.fn.countAll<number>().as("n"), eb.fn.max<string | null>("c.first_seen_at").as("newest"), eb.fn.sum<number | null>(eb.fn("length", ["c.message"])).as("length")])
    .groupBy(["c.repo", "c.number"]).as("cm");
  const files = k.selectFrom("main.pr_files as f").innerJoin(resolveKeys(db, keys, "k3"), joined("f", "k3"))
    .select((eb) => ["f.repo", "f.number", eb.fn.countAll<number>().as("n"), eb.fn.sum<number | null>(eb("f.additions", "+", eb.ref("f.deletions"))).as("lines")])
    .groupBy(["f.repo", "f.number"]).as("fl");
  const rows = await q.all(k.selectFrom(resolveKeys(db, keys, "kk"))
    .leftJoin(events, (j) => j.onRef("ev.repo", "=", "kk.repo").onRef("ev.number", "=", "kk.number"))
    .leftJoin(commits, (j) => j.onRef("cm.repo", "=", "kk.repo").onRef("cm.number", "=", "kk.number"))
    .leftJoin(files, (j) => j.onRef("fl.repo", "=", "kk.repo").onRef("fl.number", "=", "kk.number"))
    .leftJoin("main.item_reads as r", (j) => j.onRef("r.repo", "=", "kk.repo").onRef("r.number", "=", "kk.number"))
    .select(["kk.repo", "kk.number", "ev.n as events", "ev.newest as newest", "cm.n as commits", "cm.newest as newestCommit", "cm.length as commitLength", "fl.n as files", "fl.lines as lines", "r.synced_at as readAt"]));
  const out = new Map<RefKey, ActivityStats>();
  for (const r of rows) {
    if (r.events === null && r.commits === null && r.files === null && r.readAt === null) continue;
    out.set(refKey(r.repo, Number(r.number)), {
      events: Number(r.events ?? 0), newest: r.newest, commits: Number(r.commits ?? 0), newestCommit: r.newestCommit, commitLength: Number(r.commitLength ?? 0),
      files: Number(r.files ?? 0), lines: Number(r.lines ?? 0), readAt: r.readAt,
    });
  }
  return out;
}

/** The parts of one item's page in one `together` wave: item, comments, activity, commits, files, checks and read time. */
export async function loadItemDetail(db: Db, ref: RefKey, parts: ItemDetailPart[]): Promise<ItemDetail> {
  const i = ref.lastIndexOf("#");
  const keys = [{ repo: ref.slice(0, i), number: Number(ref.slice(i + 1)) }];
  const want = new Set(parts);
  const none = <T>(v: T) => Promise.resolve(v);
  const [item, comments, activity, commits, files, checks, read] = await db.together(() => Promise.all([
    want.has("item") ? loadItems(db, keys, "full") : none(new Map()),
    want.has("comments") ? loadComments(db, keys, { order: "created", body: true }) : none(new Map()),
    want.has("activity") ? loadActivity(db, keys) : none(new Map()),
    want.has("commits") ? loadCommits(db, keys) : none(new Map()),
    want.has("files") ? loadFiles(db, keys) : none(new Map()),
    want.has("checks") ? loadChecks(db, keys) : none(new Map()),
    want.has("read") ? loadItemReads(db, keys) : none(new Map()),
  ]));
  return {
    item: item.get(ref) ?? null, comments: comments.get(ref) ?? [], activity: activity.get(ref) ?? [], commits: commits.get(ref) ?? [],
    files: files.get(ref) ?? [], checks: checks.get(ref) ?? null, read: read.get(ref) ?? null,
  };
}
