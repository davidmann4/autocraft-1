// Predicates other modules embed. They keep the `main.` qualifier: scoped handles shadow some tables with views limited to
// tracked repos, and a quiet check must see all rows.
import type { Expression, SqlBool } from "kysely";
import { ref, schemaEb, type Eb, type Ex } from "../../db/kx.ts";

/** A closed quiet pull request stays quiet while its finding is neither published nor dismissed. */
const FORMER_CLOSED = ["published", "dismissed"];

/** The PR is a quiet security fix pull request: a landing or landed finding's PR on the quiet route, or a remembered quiet PR whose advisory is not yet published. */
export function quietPrExpr(eb: Eb, repo: Ex, number: Ex): Expression<SqlBool> {
  const w = schemaEb(eb);
  return eb.or([
    w.exists(w.selectFrom("main.security_findings as qf").select(w.lit(1).as("one")).where("qf.repo", "=", ref<string>(repo)).where("qf.fix_pr", "=", ref<number>(number))
      .where("qf.state", "in", ["landing", "landed"]).where("qf.fork", "is", null)),
    w.exists(w.selectFrom("main.security_quiet_prs as qp").innerJoin("main.security_findings as qg", (j) => j.onRef("qg.repo", "=", "qp.repo").onRef("qg.number", "=", "qp.finding"))
      .select(w.lit(1).as("one")).where("qp.repo", "=", ref<string>(repo)).where("qp.pr", "=", ref<number>(number)).where("qg.state", "not in", FORMER_CLOSED)),
  ]);
}

/** Some finding, in any state and on any route, has this PR as its fix PR. */
export function findingPrExpr(eb: Eb, repo: Ex, number: Ex): Expression<SqlBool> {
  const w = schemaEb(eb);
  return w.exists(w.selectFrom("main.security_findings as sf").select(w.lit(1).as("one")).where("sf.repo", "=", ref<string>(repo)).where("sf.fix_pr", "=", ref<number>(number)));
}
