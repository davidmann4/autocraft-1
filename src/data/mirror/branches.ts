// Branch and closure reads other modules ask the mirror for (M02 mirror-b).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import type { RefKey } from "./types.ts";

const DEFAULT_OWNER = "storytold";
/** Author associations whose open PRs on one shared branch make that branch shared rather than one contributor's. */
const TRUSTED = ["OWNER", "MEMBER", "COLLABORATOR"];

/**
 * Per repo: its default branch, the base of every PR, and the same-repo head branches that several open PRs by trusted authors
 * use. Three statements in one wave. A repo without any of them has no entry.
 */
export async function loadLongLivedBranches(db: Db, repos?: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (repos && !repos.length) return out;
  const add = (repo: string, branch: string): void => { (out.get(repo) ?? out.set(repo, new Set()).get(repo)!).add(branch); };
  const q = queryDb(db);
  const [defaults, bases, shared] = await db.together(() => Promise.all([
    q.all(q.k.selectFrom("repos").select(["name", "default_branch"]).where("default_branch", "is not", null).$if(!!repos, (b) => b.where(kx.inList(db, "name", repos!)))),
    q.all(q.k.selectFrom("items").select(["repo", "base_ref"]).distinct().where("kind", "=", "pr").where("base_ref", "is not", null).$if(!!repos, (b) => b.where(kx.inList(db, "repo", repos!)))),
    q.all(q.k.selectFrom("items as i").leftJoin("main.repos as r", "r.name", "i.repo").select(["i.repo", "i.head_ref"])
      .where("i.kind", "=", "pr").where("i.state", "=", "OPEN").where("i.head_ref", "is not", null).where("i.author_association", "in", TRUSTED)
      .where((eb) => eb(eb.fn<string | null>("lower", ["i.head_repo"]), "=", eb.fn<string>("lower", [eb(eb(eb.fn.coalesce("r.owner", eb.val(DEFAULT_OWNER)), "||", eb.val("/")), "||", eb.ref("i.repo"))])))
      .$if(!!repos, (b) => b.where(kx.inList(db, "i.repo", repos!)))
      .groupBy(["i.repo", "i.head_ref"]).having((eb) => eb.fn.countAll(), ">", 1)),
  ]));
  for (const r of defaults) if (r.default_branch) add(r.name, r.default_branch);
  for (const r of bases) if (r.base_ref) add(r.repo, r.base_ref);
  for (const r of shared) if (r.head_ref) add(r.repo, r.head_ref);
  return out;
}

/** Issue to the merged PR that closed it (the lowest PR number when several did), for the issues named by merged PRs of `repos`. */
export async function loadMergedClosures(db: Db, repos: string[]): Promise<Map<RefKey, RefKey>> {
  const out = new Map<RefKey, RefKey>();
  if (!repos.length) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("items as p")
    .crossJoin((eb) => kx.jsonEach(db, eb.case().when(kx.jsonValid(db, "p.closing_issues")).then(eb.ref("p.closing_issues")).else(eb.val("[]")).end(), "f", "bigint"))
    .select((eb) => ["p.repo", "f.value as number", eb.fn.min<number>("p.number").as("pr")])
    .where("p.kind", "=", "pr").where("p.state", "=", "MERGED").where(kx.inList(db, "p.repo", repos))
    .groupBy(["p.repo", "f.value"]));
  for (const r of rows) out.set(`${r.repo}#${Number(r.number)}`, `${r.repo}#${Number(r.pr)}`);
  return out;
}
