// Predicates other modules embed in their statements (src/data/** only).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";

/** Distinct repos with a queued card, for `control.loadActBlocked` in the same wave. */
export const queuedRepos = (db: Db) => queryDb(db).k.selectFrom("main.conversation_cards as qc").select("qc.repo").distinct().where("qc.state", "=", "queued");

/** Ids of running cards, for `control.countCardWrites`. */
export const runningCardIds = (db: Db) => queryDb(db).k.selectFrom("main.conversation_cards as rc").select("rc.id").where("rc.state", "=", "running");

/** Ids of held follow-ups still to settle (`held` or `filing`), to key the `loadDueHeld` wave. */
export const openHeld = (db: Db) => queryDb(db).k.selectFrom("main.held_followups as hf").select("hf.id").where("hf.state", "in", ["held", "filing"]);
