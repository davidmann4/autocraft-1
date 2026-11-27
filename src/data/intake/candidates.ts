// The statement behind recomputeHolds: the in-scope items of outside authors with their admission and release flags.
// reads: mirror.items (the candidate items and their follow-up parents, in one statement)
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { isStaff } from "../access/fragments.ts";
import { pipelineOn, tripActiveSince } from "../control/fragments.ts";
import { followupParentOf } from "../review/fragments.ts";
import { liveWorkflowExpr } from "../workflow/fragments.ts";
import { OUTSIDE_SURGE, type Candidate } from "./types.ts";

type Row = { repo: string; number: number | string; kind: string; state: string; created_at: string; author: string; author_id: number | string | null; rel: string | null; adm: string | null };

/**
 * The active breaker's trip time less one hour, as ISO text like the stored timestamps; NULL with no active trip. The
 * statement keeps the items from an hour before the trip, however old, as the surge holds need.
 */
const surgeFromSql = (db: Db, eb: kx.AnyEb) => {
  const t = tripActiveSince(eb, OUTSIDE_SURGE);
  return kx.isoMinusHours(db, t, 1);
};

/**
 * Items created since `dayAgo` (or since an hour before an active breaker's trip when `surge`), in repos with the pipeline on, with
 * no live workflow, whose author (a post-merge follow-up issue counts as its merged PR's author) is outside: not a collaborator by
 * association, not a bot, not an operator or maintainer, not one of `own` (lower case). `bots` are the review bot logins
 * (lower case) that count as bots when the author type is unknown. 1 statement.
 */
export async function loadCandidates(db: Db, o: { dayAgo: string; surge: boolean; own: string[]; bots: string[] }): Promise<Candidate[]> {
  const q = queryDb(db);
  const k = q.k as any;
  const base = k.selectFrom("main.items as i")
    .leftJoin("main.items as p", (j: any) => j.on("i.kind", "=", "issue").onRef("p.repo", "=", "i.repo").on((eb: any) => eb("p.number", "=", followupParentOf(eb, "i.repo", "i.number"))))
    .select((eb: any) => [
      "i.repo as repo", "i.number as number", "i.kind as kind", "i.state as state", "i.created_at as created_at",
      eb.fn.coalesce("p.author", "i.author").as("author"),
      eb.case().when("p.author", "is", null).then(eb.ref("i.author_id")).else(eb.ref("p.author_id")).end().as("author_id"),
      eb.case().when("p.author", "is", null).then(eb.ref("i.author_association")).else(eb.ref("p.author_association")).end().as("author_association"),
      eb.case().when("p.author", "is", null).then(eb.ref("i.author_type")).else(eb.ref("p.author_type")).end().as("author_type"),
    ])
    .where("i.author", "is not", null)
    .where((eb: any) => eb.or([eb("i.created_at", ">=", o.dayAgo), ...(o.surge ? [eb("i.created_at", ">=", surgeFromSql(db, eb))] : [])]))
    .where((eb: any) => pipelineOn(eb, "i.repo"))
    .where((eb: any) => eb.not(liveWorkflowExpr(eb, "i.repo", "i.number")));
  const rows = await q.all(k.selectFrom(base.as("b"))
    .leftJoin("main.outside_released as rl", (j: any) => j.onRef("rl.repo", "=", "b.repo").onRef("rl.number", "=", "b.number"))
    .leftJoin("main.outside_admitted as ad", (j: any) => j.onRef("ad.repo", "=", "b.repo").onRef("ad.number", "=", "b.number"))
    .select(["b.repo", "b.number", "b.kind", "b.state", "b.created_at", "b.author", "b.author_id", "rl.repo as rel", "ad.repo as adm"])
    .where((eb: any) => {
      const lowered = eb.fn("lower", ["b.author"]);
      return eb.and([
        eb(eb.fn.coalesce("b.author_association", eb.val("")), "not in", ["OWNER", "MEMBER", "COLLABORATOR"]),
        eb.not(eb.or([
          eb(eb.fn.coalesce("b.author_type", eb.val("")), "=", "Bot"),
          kx.like(db, "b.author", eb.val("%[bot]")),
          eb.and([eb("b.author_type", "is", null), eb.or([eb(lowered, "=", "github-actions"), kx.inList(db, lowered, o.bots)])]),
        ])),
        kx.inList(db, lowered, o.own, "text", true),
        eb.not(isStaff(db, eb, "b.author")),
      ]);
    })) as Row[];
  // In key order, as the groups are visited: an ORDER BY would make SQLite walk every item.
  return rows.sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : Number(a.number) - Number(b.number))).map((r) => ({
    repo: r.repo, number: Number(r.number), kind: r.kind === "pr" ? "pr" : "issue", author: r.author, author_id: r.author_id === null ? null : Number(r.author_id),
    state: r.state, created_at: r.created_at, released: r.rel !== null, admitted: r.adm !== null,
  }));
}
