// Main-branch CI heads (M02 mirror-b).
// reads: control.tracked_repos
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { hiddenRepos, trackedRepo } from "../control/fragments.ts";
import type { HiddenRepos, LatestMainHead, MainHead, MainHeadRow, MainHeadSummary } from "./types.ts";

/** Heads kept per repo. */
const KEEP_HEADS = 50;

const SUMMARY = ["m.repo", "m.head_sha", "m.branch", "m.state", "m.failing", "m.committed_at", "m.headline", "m.first_seen_at", "m.state_changed_at", "m.updated_at"] as const;

/**
 * Batched upsert keeping the state change time while the state is unchanged, then a prune to the newest 50 heads of every repo
 * of the call; returns the state per "repo@sha". The caller classifies the state. One row per head in a statement (the later wins).
 */
export async function saveMainHeads(db: Db, heads: MainHead[], at: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!heads.length) return out;
  const last = new Map(heads.map((h) => [`${h.repo}@${h.sha}`, h]));
  const q = queryDb(db);
  await db.write(async () => {
    for (const part of kx.batches([...last.values()])) {
      await q.run(q.k.insertInto("main.main_ci")
        .values(part.map((h) => ({ repo: h.repo, head_sha: h.sha, branch: h.branch, state: h.state, failing: h.failing, checks: h.checks, committed_at: h.committed_at, headline: h.headline, first_seen_at: at, state_changed_at: at, updated_at: at })))
        .onConflict((oc) => oc.columns(["repo", "head_sha"]).doUpdateSet((eb) => ({
          branch: eb.ref("excluded.branch"), state: eb.ref("excluded.state"), failing: eb.ref("excluded.failing"), checks: eb.ref("excluded.checks"),
          committed_at: eb.ref("excluded.committed_at"), headline: eb.ref("excluded.headline"), updated_at: eb.ref("excluded.updated_at"),
          state_changed_at: eb.case().when("main.main_ci.state", "=", eb.ref("excluded.state")).then(eb.ref("main.main_ci.state_changed_at")).else(eb.ref("excluded.updated_at")).end(),
        }))));
    }
    const ranked = q.k.selectFrom("main.main_ci as r")
      .select((eb) => ["r.repo", "r.head_sha", eb.fn.agg<number>("row_number").over((o) => o.partitionBy("r.repo")
        .orderBy(eb.fn.coalesce("r.committed_at", "r.first_seen_at"), "desc").orderBy("r.first_seen_at", "desc")).as("rn")])
      .where(kx.inList(db, "r.repo", [...new Set(heads.map((h) => h.repo))]));
    await q.run(q.k.deleteFrom("main.main_ci").where((eb) => eb(eb.refTuple("main.main_ci.repo", "main.main_ci.head_sha"), "in",
      eb.selectFrom(ranked.as("t")).select(["t.repo", "t.head_sha"]).where("t.rn", ">", KEEP_HEADS) as any)));
  });
  for (const [k, h] of last) out.set(k, h.state);
  return out;
}

/** Every stored head (without its check list) of tracked repos, per repo; `repos` narrows it, `hiddenOk` is the viewer's repo filter. */
export async function loadMainCi(db: Db, o: { repos?: string[]; hiddenOk?: HiddenRepos } = {}): Promise<Map<string, MainHeadSummary[]>> {
  const out = new Map<string, MainHeadSummary[]>();
  if (o.repos && !o.repos.length) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.main_ci as m").select(SUMMARY).where((eb) => trackedRepo(eb, "m.repo"))
    .$if(!!o.repos, (b) => b.where(kx.inList(db, "m.repo", o.repos!)))
    .$if(!!o.hiddenOk, (b) => b.where(hiddenRepos(db, "m.repo", o.hiddenOk!)))
    .orderBy("m.repo").orderBy("m.first_seen_at").orderBy("m.head_sha"));
  for (const r of rows) (out.get(r.repo) ?? out.set(r.repo, []).get(r.repo)!).push(r);
  return out;
}

/**
 * The heads that decide what a repo's history says (mainci/classify.ts `derive`), oldest first per tracked repo: the newest, the last green
 * one and the first red one after it. Only the newest carries its failing checks.
 */
export async function loadDecidingHeads(db: Db, hidden: HiddenRepos): Promise<Map<string, MainHeadSummary[]>> {
  const out = new Map<string, MainHeadSummary[]>();
  const q = queryDb(db);
  const newestFirst = q.k.selectFrom("main.main_ci as m").select([...SUMMARY, (eb) => eb.fn.agg<number>("row_number").over((o) => o.partitionBy("m.repo")
    .orderBy(eb.fn.coalesce("m.committed_at", "m.first_seen_at"), "desc").orderBy("m.first_seen_at", "desc").orderBy("m.head_sha", "desc")).as("rn")])
    .where((eb) => trackedRepo(eb, "m.repo")).where(hiddenRepos(db, "m.repo", hidden));
  const green = q.k.selectFrom(newestFirst.as("h")).selectAll("h")
    .select((eb) => eb.fn.min<number | null>(eb.case().when("h.state", "=", "green").then(eb.ref("h.rn")).end()).over((o) => o.partitionBy("h.repo")).as("green_rn"));
  const red = q.k.selectFrom(green.as("g")).selectAll("g")
    .select((eb) => eb.fn.max<number | null>(eb.case().when(eb.and([eb("g.state", "=", "red"), eb.or([eb("g.green_rn", "is", null), eb("g.rn", "<", eb.ref("g.green_rn"))])])).then(eb.ref("g.rn")).end()).over((o) => o.partitionBy("g.repo")).as("red_rn"));
  const rows = await q.all(q.k.selectFrom(red.as("m")).select([...SUMMARY.filter((c) => c !== "m.failing"), (eb) => eb.case().when("m.rn", "=", 1).then(eb.ref("m.failing")).else("[]").end().as("failing")])
    .where((eb) => eb.or([eb("m.rn", "=", 1), eb("m.rn", "=", eb.ref("m.green_rn")), eb("m.rn", "=", eb.ref("m.red_rn"))]))
    .orderBy("m.repo").orderBy("m.rn", "desc"));
  for (const r of rows) (out.get(r.repo) ?? out.set(r.repo, []).get(r.repo)!).push(r as MainHeadSummary);
  return out;
}

/** Heads keyed "repo@sha" (missing ones have no entry). */
export async function loadMainCiAt(db: Db, pairs: { repo: string; sha: string }[]): Promise<Map<string, MainHeadRow>> {
  const out = new Map<string, MainHeadRow>();
  if (!pairs.length) return out;
  const q = queryDb(db);
  for (const part of kx.chunks(pairs)) {
    const rows = await q.all(q.k.selectFrom("main.main_ci as m").select(kx.cols("main_ci", "m")).where(kx.tupleIn(db, ["m.repo", "m.head_sha"], part.map((p) => [p.repo, p.sha]), ["text", "text"])));
    for (const r of rows) out.set(`${r.repo}@${r.head_sha}`, r);
  }
  return out;
}

/** The head the latest poll saw in each repo (every poll refreshes `updated_at` of the head it reads, so a force push back to an older commit counts). */
export async function loadLatestMainHeads(db: Db, repos?: string[]): Promise<Map<string, LatestMainHead>> {
  const out = new Map<string, LatestMainHead>();
  if (repos && !repos.length) return out;
  const q = queryDb(db);
  const ranked = q.k.selectFrom("main.main_ci as m")
    .select((eb) => ["m.repo", "m.head_sha", "m.state", "m.committed_at", "m.updated_at", eb.fn.agg<number>("row_number").over((o) => o.partitionBy("m.repo").orderBy("m.updated_at", "desc").orderBy("m.first_seen_at", "desc")).as("rn")])
    .$if(!!repos, (b) => b.where(kx.inList(db, "m.repo", repos!)));
  const rows = await q.all(q.k.selectFrom(ranked.as("t")).select(["t.repo", "t.head_sha", "t.state", "t.committed_at", "t.updated_at"]).where("t.rn", "=", 1));
  for (const r of rows) out.set(r.repo, { head_sha: r.head_sha, state: r.state, committed_at: r.committed_at, updated_at: r.updated_at });
  return out;
}
