// Our own commits (M06 control-b).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";

/** Batched insert on conflict do nothing, called after a successful push. */
export async function addOwnCommits(db: Db, rows: { repo: string; sha: string; action: string; at?: string }[]): Promise<void> {
  if (!rows.length) return;
  const q = queryDb(db);
  const now = new Date().toISOString();
  const values = rows.map((r) => ({ repo: r.repo, sha: r.sha, action: r.action, at: r.at ?? now }));
  const insert = async (): Promise<void> => { for (const part of kx.batches(values)) await q.run(q.k.insertInto("main.own_commits").values(part).onConflict((oc) => oc.doNothing())); };
  if (values.length > kx.BATCH_ROWS && !db.inTransaction()) await db.write(insert);
  else await insert();
}

/** Membership of `(repo, sha)` pairs, keyed "repo@sha". */
export async function loadOwnCommits(db: Db, pairs: { repo: string; sha: string }[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!pairs.length) return out;
  const q = queryDb(db);
  const unique = [...new Map(pairs.map((p) => [`${p.repo}@${p.sha}`, [p.repo, p.sha] as const])).values()];
  const found = await Promise.all(kx.chunks(unique).map((c) => q.all(q.k.selectFrom("main.own_commits").select(["repo", "sha"]).where(kx.tupleIn(db, ["repo", "sha"], c, ["text", "text"])))));
  for (const r of found.flat()) out.add(`${r.repo}@${r.sha}`);
  return out;
}
