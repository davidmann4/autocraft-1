// The database as tests use it: the app's handle with its query methods (`QueryDb`), which feature code holds without
// them. Tests seed and read tables directly through it.
import type { DatabaseSync } from "node:sqlite";
import * as open from "../../src/db/open.ts";
import { queryDb, type QueryDb } from "../../src/db/query-db.ts";

export type Db = QueryDb;

/** `connectDb` of src/db/open.ts, with the query methods. */
export const connectDb = async (...args: Parameters<typeof open.connectDb>): Promise<Db> => queryDb(await open.connectDb(...args));
/** `dbFor` of src/db/open.ts, with the query methods. */
export const dbFor = async (sync: DatabaseSync): Promise<Db> => queryDb(await open.dbFor(sync));
/** `openDb` of src/db/open.ts, with the query methods. */
export const openDb = async (): Promise<Db> => queryDb(await open.openDb());
