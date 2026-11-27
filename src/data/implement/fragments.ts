// Predicates other modules embed; no loader or writer is exported through them.
import type { Expression, SqlBool } from "kysely";
import { schemaEb, type Eb } from "../../db/kx.ts";
import { registerKeySource } from "../keys.ts";
import { queryDb } from "../../db/query-db.ts";
import { ENDED_STATES, LIVE_STATES } from "./types.ts";

const ended = [...ENDED_STATES];
const live = [...LIVE_STATES];

/** An attempt of an issue in `repo` whose `pr_number` is `prNumber`; with `current`, not in an ended state. */
export function attemptOfPr(eb: Eb, repo: Expression<string> | string, prNumber: Expression<number> | number, o: { current?: boolean } = {}): Expression<SqlBool> {
  const w = schemaEb(eb);
  const r = typeof repo === "string" ? w.val(repo) : repo;
  const n = typeof prNumber === "number" ? w.val(prNumber) : prNumber;
  return w.exists(w.selectFrom("implementations as im").select(w.lit(1).as("one")).where("im.repo", "=", r).where("im.pr_number", "=", n)
    .$if(!!o.current, (q) => q.where("im.state", "not in", ended)));
}

registerKeySource<undefined>("implement.liveIssues", (db) =>
  queryDb(db).k.selectFrom("implementations as im").select(["im.repo as repo", "im.number as number"]).where("im.state", "in", live));
