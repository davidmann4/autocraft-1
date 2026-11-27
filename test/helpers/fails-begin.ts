import type { Db } from "./raw-db.ts";

/** `db` with a lost connection wherever a write transaction starts, as a GitHub write's audit row does before its request. */
export const failsBegin = (db: Db): Db => new Proxy(db, { get: (t, k) => {
  if (k === "write") return async () => { throw new Error("connection lost"); };
  const v = Reflect.get(t, k) as unknown;
  return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
} });
