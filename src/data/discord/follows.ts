// What the bot's threads and command replies follow (`discord_follows`).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import type { FollowPost, FollowRow, Ref } from "./types.ts";

const COLS = ["target_hash", "repo", "number", "kind", "channel_hash", "sealed", "command", "login", "at"] as const;
type Row = { target_hash: string; repo: string; number: number; kind: string; channel_hash: string; sealed: string; command: string; login: string; at: string };
const rowOf = (r: Row): FollowRow => ({
  targetHash: r.target_hash, repo: r.repo, number: Number(r.number), kind: r.kind === "reply" ? "reply" : "thread", channelHash: r.channel_hash,
  sealed: r.sealed, command: r.command, login: r.login, at: r.at,
});

/** The rows of each target; a target with no rows is absent. */
export async function loadFollows(db: Db, targetHashes: string[]): Promise<Map<string, FollowRow[]>> {
  const q = queryDb(db);
  const out = new Map<string, FollowRow[]>();
  for (const part of kx.chunks([...new Set(targetHashes)])) {
    for (const r of await q.all(q.k.selectFrom("main.discord_follows").select(COLS).where(kx.inList(db, "target_hash", part)), { label: "discord.loadFollows" })) {
      const f = rowOf(r);
      const list = out.get(f.targetHash);
      if (list) list.push(f); else out.set(f.targetHash, [f]);
    }
  }
  return out;
}

/** The rows that follow each item; an item nobody follows is absent. */
export async function loadFollowsOfItems(db: Db, refs: Ref[]): Promise<Map<Ref, FollowRow[]>> {
  const q = queryDb(db);
  const out = new Map<Ref, FollowRow[]>();
  if (!refs.length) return out;
  const rows = await q.all(q.k.selectFrom("main.discord_follows as f").select(COLS.map((c) => `f.${c}` as const)).where(kx.refIn(db, "f", refs)), { label: "discord.loadFollowsOfItems" });
  for (const r of rows) {
    const f = rowOf(r);
    const key = `${f.repo}#${f.number}`;
    const list = out.get(key);
    if (list) list.push(f); else out.set(key, [f]);
  }
  return out;
}

/** The rows of targets started from a channel, or of the target itself, written after `since`, whose item is numbered one of `numbers`. */
export async function loadChannelFollows(db: Db, f: { channelHash: string; targetHash: string; numbers: number[]; since: string }): Promise<FollowRow[]> {
  if (!f.numbers.length) return [];
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.discord_follows").select(COLS).where((eb) => eb.or([eb("channel_hash", "=", f.channelHash), eb("target_hash", "=", f.targetHash)]))
    .where("at", ">", f.since).where(kx.inList(db, "number", f.numbers, "bigint")), { label: "discord.loadChannelFollows" });
  return rows.map(rowOf);
}

/** Upserts rows by (target, item): an item named again takes the newer command, sender and time. Rows older than `before` go. */
export async function saveFollows(db: Db, rows: FollowRow[], before: string): Promise<void> {
  const q = queryDb(db);
  const unique = [...new Map(rows.map((r) => [`${r.targetHash}\0${r.repo}\0${r.number}`, r])).values()];
  await db.write(async () => {
    await q.run(q.k.deleteFrom("main.discord_follows").where("at", "<", before));
    for (const part of kx.batches(unique)) {
      await q.run(q.k.insertInto("main.discord_follows").values(part.map((r) => ({
        target_hash: r.targetHash, repo: r.repo, number: r.number, kind: r.kind, channel_hash: r.channelHash, sealed: r.sealed, command: r.command, login: r.login, at: r.at,
      }))).onConflict((oc) => oc.columns(["target_hash", "repo", "number"]).doUpdateSet(kx.excluded(["kind", "channel_hash", "sealed", "command", "login", "at"]))));
    }
  });
}

/** Deletes the rows of targets, or of the channels they were sent in. */
export async function removeFollows(db: Db, hashes: string[]): Promise<number> {
  const q = queryDb(db);
  let n = 0;
  for (const part of kx.chunks([...new Set(hashes)])) {
    n += Number((await q.run(q.k.deleteFrom("main.discord_follows").where((eb) => eb.or([kx.inList(db, "target_hash", part), kx.inList(db, "channel_hash", part)])))).changes);
  }
  return n;
}

/** Every row's target and seal, for the deletion request by user id (the sender is sealed in the row); read on its own, never fused. */
export async function loadSealedFollows(db: Db): Promise<{ targetHash: string; sealed: string }[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.discord_follows").select(["target_hash", "sealed"]), { alone: true, label: "discord.loadSealedFollows" });
  return rows.map((r) => ({ targetHash: r.target_hash, sealed: r.sealed }));
}

/** Deletes rows by (target, seal). */
export async function removeSealedFollows(db: Db, rows: { targetHash: string; sealed: string }[]): Promise<number> {
  const q = queryDb(db);
  let n = 0;
  for (const part of kx.chunks(rows.map((r): [string, string] => [r.targetHash, r.sealed]))) {
    n += Number((await q.run(q.k.deleteFrom("main.discord_follows").where(kx.tupleIn(db, ["target_hash", "sealed"], part, ["text", "text"])))).changes);
  }
  return n;
}

/** Every follow row; the table holds what commands named in the last FOLLOW_KEEP_DAYS (src/discord/threads.ts). */
export async function loadAllFollows(db: Db): Promise<FollowRow[]> {
  const q = queryDb(db);
  return (await q.all(q.k.selectFrom("main.discord_follows").select(COLS), { label: "discord.loadAllFollows" })).map(rowOf);
}

const POST_COLS = ["target_hash", "repo", "number", "status_hash", "result_key", "result_hash", "link_hash", "sealed", "at"] as const;

/** What the bot last posted about each followed (target, item), by `target\0repo\0number`. */
export async function loadFollowPosts(db: Db): Promise<Map<string, FollowPost>> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.discord_follow_posts").select(POST_COLS), { label: "discord.loadFollowPosts" });
  return new Map(rows.map((r) => {
    const p: FollowPost = { targetHash: r.target_hash, repo: r.repo, number: Number(r.number), statusHash: r.status_hash, resultKey: r.result_key, resultHash: r.result_hash, linkHash: r.link_hash, sealed: r.sealed, at: r.at };
    return [followPostKey(p), p];
  }));
}

/** What the bot posted about each item of the targets. */
export async function loadFollowPostsOf(db: Db, targetHashes: string[]): Promise<FollowPost[]> {
  const q = queryDb(db);
  const out: FollowPost[] = [];
  for (const part of kx.chunks([...new Set(targetHashes)])) {
    for (const r of await q.all(q.k.selectFrom("main.discord_follow_posts").select(POST_COLS).where(kx.inList(db, "target_hash", part)), { label: "discord.loadFollowPostsOf" })) {
      out.push({ targetHash: r.target_hash, repo: r.repo, number: Number(r.number), statusHash: r.status_hash, resultKey: r.result_key, resultHash: r.result_hash, linkHash: r.link_hash, sealed: r.sealed, at: r.at });
    }
  }
  return out;
}

export const followPostKey = (p: { targetHash: string; repo: string; number: number }): string => `${p.targetHash}\0${p.repo}\0${p.number}`;

/** Upserts whole rows by (target, item). */
export async function saveFollowPosts(db: Db, rows: FollowPost[]): Promise<void> {
  if (!rows.length) return;
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.batches(rows)) {
      await q.run(q.k.insertInto("main.discord_follow_posts").values(part.map((p) => ({
        target_hash: p.targetHash, repo: p.repo, number: p.number, status_hash: p.statusHash, result_key: p.resultKey, result_hash: p.resultHash, link_hash: p.linkHash, sealed: p.sealed, at: p.at,
      }))).onConflict((oc) => oc.columns(["target_hash", "repo", "number"]).doUpdateSet(kx.excluded(["status_hash", "result_key", "result_hash", "link_hash", "sealed", "at"]))));
    }
  });
}

/** Deletes the rows whose (target, item) nobody follows any more. */
export async function pruneFollowPosts(db: Db): Promise<number> {
  const q = queryDb(db);
  const r = await q.run(q.k.deleteFrom("main.discord_follow_posts").where((eb) => eb.not(eb.exists(eb.selectFrom("main.discord_follows as f").select(eb.lit(1).as("one"))
    .whereRef("f.target_hash", "=", "main.discord_follow_posts.target_hash").whereRef("f.repo", "=", "main.discord_follow_posts.repo").whereRef("f.number", "=", "main.discord_follow_posts.number")))));
  return Number(r.changes);
}
