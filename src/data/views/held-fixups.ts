// reads: planner.item_plans, mirror.items
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import type { Db } from "../../db/index.ts";
import { hasFixupAt } from "../changes/fragments.ts";
import { loadLatestFixupAt } from "../changes/index.ts";
import { loadReviewsAt } from "../review/index.ts";
import type { HeldFixupFacts } from "./types.ts";

/**
 * Open PRs of `repos` (narrowed to `repo` when given) whose current plan holds the fix-up at the PR's head and that have no fix-up in a
 * live state at that head, oldest first, at most `limit`; each with the review's reason and fixes at the head and the newest fix-up row there
 * (`light`: the PRs alone).
 */
export async function loadHeldFixups(db: Db, o: { repos: string[]; repo: string | null; limit: number; light?: boolean }): Promise<HeldFixupFacts[]> {
  const want = o.repo ? o.repos.filter((r) => r === o.repo) : o.repos;
  if (!want.length) return [];
  const q = queryDb(db);
  const held = await q.all(q.k.selectFrom("main.item_plans as p")
    .innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "p.repo").onRef("i.number", "=", "p.number"))
    .select(["p.repo", "p.number", "p.head", "i.title", "i.author", "p.note"])
    .$narrowType<{ head: string }>()
    .where("p.kind", "=", "pr").where(kx.inList(db, "p.repo", want)).where("i.state", "=", "OPEN").whereRef("p.head", "=", "i.head_oid")
    .where(kx.jsonValid(db, "p.view")).where((eb) => eb(kx.jsonText(db, "p.view", "$.fixup"), "=", "hold"))
    .where((eb) => eb.not(hasFixupAt(eb, "p", "p.head", ["pushing", "linting", "pushed"])))
    .orderBy("i.created_at", (b) => b.asc().nullsFirst()).orderBy("p.repo").orderBy("p.number").limit(o.limit));
  if (!held.length) return [];
  if (o.light) return held.map((h) => ({ repo: h.repo, number: h.number, title: h.title, author: h.author, note: h.note, head: h.head, reason: null, fixes: [], latestFixup: null }));
  const [reviews, latest] = await db.together(() => Promise.all([
    loadReviewsAt(db, held.map((h) => ({ repo: h.repo, number: h.number, head: h.head }))),
    loadLatestFixupAt(db, held.map((h) => ({ ref: `${h.repo}#${h.number}`, head: h.head }))),
  ]));
  return held.map((h) => {
    const at = `${h.repo}#${h.number}@${h.head}`;
    const review = reviews.get(at);
    return { repo: h.repo, number: h.number, title: h.title, author: h.author, note: h.note, head: h.head, reason: review?.reason ?? null, fixes: review?.fixes ?? [], latestFixup: latest.get(at) ?? null };
  });
}
