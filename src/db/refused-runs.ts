// Once: runs the model's safety filter declined before `agent_runs.refusal` existed get it from the summary refuseLease wrote
// (src/data/runners/calls-submit.ts): "refused by <model> on <login>'s Task Runner; retried on <where>" or "refused by ...".
// Their `call_id` stays null, so the Agents page cannot name their retry. Runs on SQLite with backfill() (src/db.ts) and on
// Postgres inside migratePg (src/db/pg-triggers.ts); the REFUSAL_BACKFILLED marker makes a second run change nothing.
import type { DatabaseSync } from "node:sqlite";
import type { PgClient } from "./pg-triggers.ts";

export const REFUSAL_BACKFILLED = "agent_runs_refusal_backfilled";

const STATEMENTS = (main: string): string[] => {
  const undone = `NOT EXISTS (SELECT 1 FROM ${main}settings m WHERE m.key = '${REFUSAL_BACKFILLED}')`;
  const old = `state = 'failed' AND refusal IS NULL AND summary LIKE 'refused by % on %''s Task Runner%' AND ${undone}`;
  return [
    `UPDATE ${main}agent_runs SET refusal = 'retried' WHERE ${old} AND summary LIKE '%; retried on %'`,
    `UPDATE ${main}agent_runs SET refusal = 'failed' WHERE ${old}`,
    `INSERT INTO ${main}settings (key, value) VALUES ('${REFUSAL_BACKFILLED}', '1') ON CONFLICT (key) DO NOTHING`,
  ];
};

export function backfillRefusalsSqlite(db: DatabaseSync): void {
  for (const q of STATEMENTS("main.")) db.exec(q);
}

export async function backfillRefusalsPg(client: PgClient): Promise<void> {
  for (const q of STATEMENTS("")) await client.query(q);
}
