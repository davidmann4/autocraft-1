// Mergeable-unknown state (`merge_state`) (package merge-a).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { openItem } from "../mirror/fragments.ts";
import type { PrChecks, UnknownState } from "./types.ts";

const known = (r: PrChecks): boolean => r.mergeable === "MERGEABLE" || r.mergeable === "CONFLICTING";

/**
 * Upserts the rows waiting on GitHub's mergeable answer (`reads + 1` at the same head, reset at a new head) and deletes the rest.
 * A row waits when its mergeable state is unknown, the PR is open with passing CI and a take review at this head (`taken`, `repo#number@head`, loaded by the caller).
 */
export async function noteMergeable(db: Db, rows: PrChecks[], at: string, taken: Set<string>): Promise<void> {
  if (rows.length === 0) return;
  const q = queryDb(db);
  const last = new Map(rows.map((r) => [`${r.repo}#${r.number}`, r]));
  const waiting = [...last.values()].filter((r) => !known(r) && r.state === "OPEN" && r.overall === "success" && taken.has(`${r.repo}#${r.number}@${r.head_oid}`));
  const waitingRefs = new Set(waiting.map((r) => `${r.repo}#${r.number}`));
  const rest = [...last.entries()].filter(([ref]) => !waitingRefs.has(ref)).map(([, r]): [string, number] => [r.repo, r.number]);
  await db.write(async () => {
    // A row at the same head counts one more read; a new head starts again, so a concurrent writer cannot lose a count.
    for (const values of kx.batches(waiting.map((r) => ({ repo: r.repo, number: r.number, head: r.head_oid, since: at, reads: 1, rereads: 0, stuck: 0 }))))
      await q.run(q.k.insertInto("merge_state").values(values).onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet((eb) => {
        const same = eb("merge_state.head", "=", eb.ref("excluded.head"));
        const keep = (col: "since" | "rereads" | "stuck", fresh: unknown) => eb.case().when(same).then(eb.ref(`merge_state.${col}`)).else(fresh as any).end();
        return {
          reads: eb.case().when(same).then(eb("merge_state.reads", "+", 1)).else(1).end(),
          since: keep("since", eb.ref("excluded.since")), rereads: keep("rereads", 0), stuck: keep("stuck", 0), head: eb.ref("excluded.head"),
        };
      })));
    if (rest.length) await q.run(q.k.deleteFrom("merge_state").where(kx.refIn(db, "merge_state", rest)));
  });
}

/** `merge_state` rows of the repo that are open PRs. 1 statement. */
export async function loadUnknownDue(db: Db, repo: string): Promise<{ number: number; state: UnknownState }[]> {
  const q = queryDb(db);
  // reads: mirror.items
  const rows = await q.all(q.k.selectFrom("merge_state as s").select(["s.number", "s.head", "s.since", "s.reads", "s.rereads", "s.stuck"])
    .where("s.repo", "=", repo).where((eb) => openItem(eb, "s.repo", "s.number", { kind: "pr" })).orderBy("s.number"));
  return rows.map((r) => ({ number: r.number, state: { head: r.head, since: r.since, reads: r.reads, rereads: r.rereads, stuck: !!r.stuck } }));
}

/** Marks rows stuck after a read through the REST API; a row rewritten meanwhile does not match. Returns the rows changed. */
export async function markUnknownStuck(db: Db, rows: { repo: string; number: number; head: string; reads: number }[]): Promise<number> {
  if (rows.length === 0) return 0;
  const q = queryDb(db);
  let changed = 0;
  await db.write(async () => {
    for (const chunk of kx.chunks(rows)) {
      const v = kx.valuesTable(db, chunk, { repo: "text", number: "bigint", head: "text", reads: "bigint" }, "v");
      changed += (await q.run((q.k as any).updateTable("merge_state").from(v)
        .set((eb: any) => ({ rereads: eb("merge_state.rereads", "+", 1), stuck: 1 }))
        .where((eb: any) => eb.and([eb("merge_state.repo", "=", eb.ref("v.repo")), eb("merge_state.number", "=", eb.ref("v.number")), eb("merge_state.head", "=", eb.ref("v.head")), eb("merge_state.reads", "=", eb.ref("v.reads"))])))).changes;
    }
  });
  return changed;
}

/** Removes rows of closed or merged PRs, by repo or by keys. Returns the rows removed. */
export async function removeMergeState(db: Db, f: { repo: string; closed: true } | { keys: { repo: string; number: number }[] }): Promise<number> {
  const q = queryDb(db);
  if ("keys" in f) {
    if (f.keys.length === 0) return 0;
    return (await q.run(q.k.deleteFrom("merge_state").where(kx.refIn(db, "merge_state", f.keys.map((k): [string, number] => [k.repo, k.number]))))).changes;
  }
  // reads: mirror.items
  return (await q.run(q.k.deleteFrom("merge_state").where("repo", "=", f.repo).where((eb) => eb.not(openItem(eb, "merge_state.repo", "merge_state.number", { kind: "pr" }))))).changes;
}
