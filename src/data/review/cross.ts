// reads: mirror.comments, mirror.items, mirror.repos, access.access, control.audit, implement.implementations, workflow.item_workflows
// The discussion statements filter comments by "not ours" inside an aggregate, so they join the mirror, access and audit rows in
// one statement. loadFollowupFixPrs and loadPendingDefects read `implementations.pr_number`;
// the pre-merge base match reads the repo's default branch.
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import { inMergeEntry } from "../workflow/fragments.ts";
import { reviewWindow } from "./rows.ts";

const MAINTAINER_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];

/** "Written by someone other than us" (`c` is the comments alias): not one of our logins (`own`, lower case), not our review post, and not a comment the pipeline wrote (its audited text) under a person's login. */
const notOurs = (db: Db, eb: kx.AnyEb, own: readonly string[]) => {
  const e: kx.AnyEb = eb;
  return eb.and([
    kx.inList(db, eb.fn("lower", [eb.fn.coalesce("c.author", eb.val(""))]), own.length ? own : [""], "text", true),
    eb("c.id", "not in", e.selectFrom("main.review_posts as rp").select("rp.review_id").whereRef("rp.repo", "=", "c.repo").whereRef("rp.number", "=", "c.number")),
    eb.not(eb.exists(e.selectFrom("main.audit as au").select(e.lit(1).as("one")).where((a) => a.and([
      a("au.target", "=", a(a(a.ref("c.repo"), "||", a.val("#")), "||", kx.exprOf(a, "c.number"))),
      a("c.body", "is not", null),
      a(kx.jsonText(db, "au.details", "$.text"), "=", a.ref("c.body")),
    ])))),
  ]);
};

/** A comment by an association that maintains the repo, or by a dashboard operator or maintainer. */
const byMaintainer = (db: Db, eb: kx.AnyEb) => eb.or([
  eb("c.author_association", "in", MAINTAINER_ASSOCIATIONS),
  eb.exists((eb as kx.AnyEb).selectFrom("main.access as a").select(eb.lit(1).as("one")).where(kx.ciEq(db, "a.login", "c.author")).where("a.role", "in", ["operator", "maintainer"])),
]);

/** Per PR of `keys`: the newest counted comment by someone else and the newest by a maintainer ("" when none). Issues are left out. */
export function discussionAgg(db: Db, keys: KeySource, own: readonly string[]) {
  const q = queryDb(db);
  return q.k.selectFrom("main.comments as c")
    .innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "c.repo").onRef("kk.number", "=", "c.number"))
    .select((eb) => ["c.repo", "c.number",
      eb.fn.coalesce(eb.fn.max<string | null>("c.created_at"), eb.val("")).as("newest"),
      eb.fn.coalesce(eb.fn.max<string | null>(eb.case().when(byMaintainer(db, eb)).then(eb.ref("c.created_at")).end()), eb.val("")).as("maint")])
    .where("c.counted", "=", 1)
    .where((eb) => notOurs(db, eb, own))
    .where((eb) => eb.not(eb.exists((eb as kx.AnyEb).selectFrom("main.items as i").select(eb.lit(1).as("one")).whereRef("i.repo", "=", "c.repo").whereRef("i.number", "=", "c.number").where("i.kind", "=", "issue"))))
    .groupBy(["c.repo", "c.number"]);
}

/**
 * The counted entries (id and body) of the PRs whose newest maintainer entry is newer, to the second, than their latest review's `seen_at`
 * (else its time): only there can the hash of the discussion matter. A PR with no review has none.
 */
export function discussionBodies(db: Db, keys: KeySource, own: readonly string[]) {
  const q = queryDb(db);
  const latest = q.k.selectFrom(reviewWindow(db, keys).as("t")).select(["t.repo", "t.number", "t.seen_at", "t.at"]).where("t.rn", "=", 1);
  const sec = (eb: kx.AnyEb, col: kx.Ex) => eb.fn<string>("substr", [kx.exprOf(eb, col), eb.lit(1), eb.lit(19)]);
  return q.k.selectFrom("main.comments as c")
    .innerJoin(discussionAgg(db, keys, own).as("g"), (j) => j.onRef("g.repo", "=", "c.repo").onRef("g.number", "=", "c.number"))
    .innerJoin(latest.as("lr"), (j) => j.onRef("lr.repo", "=", "c.repo").onRef("lr.number", "=", "c.number"))
    .select(["c.repo", "c.number", "c.id", "c.body"])
    .where("c.counted", "=", 1)
    .where((eb) => notOurs(db, eb, own))
    .where("g.maint", "<>", "")
    .where((eb) => eb(sec(eb, "g.maint"), ">", sec(eb, eb.fn.coalesce("lr.seen_at", "lr.at"))));
}

/** Mirrored comments and review bodies others wrote, oldest first; `maint` as the review prompt ranks them (a maintainer other than the PR's author). */
export function discussionEntries(db: Db, keys: KeySource, own: readonly string[]) {
  const q = queryDb(db);
  return q.k.selectFrom("main.comments as c")
    .innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "c.repo").onRef("kk.number", "=", "c.number"))
    .select((eb) => ["c.repo", "c.number", "c.id", "c.kind", "c.author", "c.created_at", "c.body", "c.review_state", "c.counted",
      eb.case().when(eb.and([
        byMaintainer(db, eb),
        eb(eb.fn.coalesce("c.author", eb.val("")), "<>", eb.fn.coalesce((eb as kx.AnyEb).selectFrom("main.items as i").select("i.author").whereRef("i.repo", "=", "c.repo").whereRef("i.number", "=", "c.number"), eb.val(""))),
      ])).then(1).else(0).end().as("maint")])
    .where((eb) => notOurs(db, eb, own))
    .orderBy("c.created_at", (o) => o.asc().nullsFirst()).orderBy(kx.rowid("main.comments", "c"));
}

/** Pre-merge rows read against the base branch their head's Opus review read (a row or review that recorded none counts as matching). */
export function premergeBase(db: Db) {
  const q = queryDb(db);
  return q.k.selectFrom("main.premerge_reviews as p")
    .leftJoin("main.opus_reviews as o", (j) => j.onRef("o.repo", "=", "p.repo").onRef("o.number", "=", "p.number").onRef("o.head_oid", "=", "p.head_oid"))
    .leftJoin("main.repos as r", "r.name", "p.repo")
    .where((eb) => eb.or([eb("p.base_ref", "is", null), eb(eb.fn.coalesce("o.base_ref", "r.default_branch"), "is", null), eb("p.base_ref", "=", eb.fn.coalesce("o.base_ref", "r.default_branch"))]));
}

/** The reviewed heads of the PRs of `keys` that have a live workflow of the merge entry. */
export function mergeEntryReviews(db: Db, keys: KeySource) {
  const q = queryDb(db);
  return q.k.selectFrom("main.opus_reviews as o")
    .innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "o.repo").onRef("kk.number", "=", "o.number"))
    .select(["o.repo", "o.number", "o.head_oid", "o.at"]).where("o.verdict", "is not", null).where((eb) => inMergeEntry(eb, "o.repo", "o.number"));
}

/** `(repo, pr_number)` of implementation PRs that fix a follow-up issue this stage filed, for the PRs of `keys`. */
export function followupFixLinks(db: Db, keys: KeySource) {
  const q = queryDb(db);
  return q.k.selectFrom("main.implementations as im")
    .innerJoin("main.postmerge_followups as pf", (j) => j.onRef("pf.repo", "=", "im.repo").onRef("pf.issue_number", "=", "im.number"))
    .innerJoin(resolveKeys(db, keys, "kk"), (j) => j.onRef("kk.repo", "=", "im.repo").onRef("kk.number", "=", "im.pr_number"))
    .select(["im.repo as repo", "im.pr_number as number"]).distinct();
}
