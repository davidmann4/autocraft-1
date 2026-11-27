// The implement tests' reads and writes of attempts by id, over the implement module and its row shapes.
import type { Db } from "./helpers/raw-db.ts";
import { recordSteps, startAttempt } from "../src/data/implement/index.ts";
import { IMPL_COLS, ofRow, roundOf, type ImplRow, type RoundRow } from "../src/data/implement/rows.ts";
import { currentAttempt } from "../src/implement/attempt.ts";
import type { Implementation, ImplementationPatch, ImplementationRound, ImplementationState } from "../src/implement/types.ts";

export async function startImplementation(db: Db, o: { repo: string; number: number; queuedBy: string; textHash: string; baseSha?: string | null }, at?: string): Promise<Implementation> {
  const r = await startAttempt(db, o, at);
  if (!r) throw new Error(`${o.repo}#${o.number} has a current attempt`);
  return r;
}

export async function setImplementationState(db: Db, id: number, state: ImplementationState, patch: ImplementationPatch = {}, at?: string): Promise<void> {
  await recordSteps(db, [{ id, to: state, patch }], at);
}

export async function implementationById(db: Db, id: number): Promise<Implementation | null> {
  const r = await db.get(db.k.selectFrom("main.implementations").select([...IMPL_COLS] as never).where("id", "=", id));
  return r ? ofRow(r as unknown as ImplRow) : null;
}

export const currentImplementation = async (db: Db, repo: string, number: number): Promise<Implementation | null> => (await currentAttempt(db, repo, number))?.impl ?? null;

export async function roundsOf(db: Db, implementationId: number): Promise<ImplementationRound[]> {
  const rows = await db.all(db.k.selectFrom("main.implementation_rounds").select(["id", "implementation_id", "kind", "call_id", "result", "at"]).where("implementation_id", "=", implementationId).orderBy("id"));
  return rows.map((r) => roundOf(r as unknown as RoundRow));
}
