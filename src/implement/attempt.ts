// An attempt as an implement step holds it: the row and its rounds read through the implement module, and the step's writes
// as one `recordSteps` entry each. A step keeps the attempt it wrote in memory instead of reading it back.
import type { Db } from "../db/index.ts";
import { loadImplementationView, recordSteps } from "../data/implement/index.ts";
import type { AttemptStep } from "../data/implement/index.ts";
import { ENDED_STATES, type Implementation, type ImplementationPatch, type ImplementationRound, type ImplementationState, type RoundKind } from "./types.ts";

export type Attempt = { impl: Implementation; rounds: ImplementationRound[] };
export type NewRound = { kind: RoundKind; callId?: number | null; result?: unknown };

const refOf = (impl: { repo: string; number: number }) => `${impl.repo}#${impl.number}` as const;

/** The issue's current attempt with its rounds, oldest first; null when it has none. */
export async function currentAttempt(db: Db, repo: string, number: number): Promise<Attempt | null> {
  const v = await loadImplementationView(db, `${repo}#${number}`);
  return v && !ENDED_STATES.has(v.impl.state) ? { impl: v.impl, rounds: v.rounds } : null;
}

/** The attempt and its rounds as stored now; null when it is no longer the issue's latest attempt (a newer one started). */
export async function attemptNow(db: Db, impl: { id: number; repo: string; number: number }): Promise<Attempt | null> {
  const v = await loadImplementationView(db, refOf(impl));
  return v && v.impl.id === impl.id ? { impl: v.impl, rounds: v.rounds } : null;
}

/**
 * Writes one step of the attempt in one transaction: the move to `to` and the patch's columns (only while the state is one of
 * `expect`, when given), and the rounds (only when the move applied). Returns the attempt as written and the new round ids, or
 * null when `expect` did not match.
 */
export async function writeStep(db: Db, impl: Implementation, o: { to?: ImplementationState; patch?: ImplementationPatch; expect?: readonly ImplementationState[]; rounds?: NewRound[]; setRounds?: { id: number; result: unknown }[]; at?: string }): Promise<{ impl: Implementation; roundIds: number[] } | null> {
  const at = o.at ?? new Date().toISOString();
  const step: AttemptStep = {
    id: impl.id, ...(o.to && { to: o.to }), ...(o.patch && { patch: o.patch }), ...(o.expect && { expect: [...o.expect] }),
    ...(o.rounds?.length && { addRounds: o.rounds }), ...(o.setRounds?.length && { setRounds: o.setRounds }),
  };
  const r = await recordSteps(db, [step], at);
  if (!r.applied.get(impl.id)) return null;
  const wrote = o.to !== undefined || (o.patch && Object.keys(o.patch).length > 0);
  return { impl: { ...impl, ...o.patch, ...(o.to && { state: o.to }), ...(wrote && { updatedAt: at }) }, roundIds: r.roundIds.get(impl.id) ?? [] };
}

/** Adds rounds to the attempt, whatever its state; returns their ids in order. */
export async function addRounds(db: Db, implId: number, rounds: NewRound[], at?: string): Promise<number[]> {
  const r = await recordSteps(db, [{ id: implId, addRounds: rounds }], at);
  return r.roundIds.get(implId) ?? [];
}

/** Replaces a round's result (a turn round settled after it was queued). */
export async function setRound(db: Db, implId: number, roundId: number, result: unknown): Promise<void> {
  await recordSteps(db, [{ id: implId, setRounds: [{ id: roundId, result }] }]);
}

/** The round as written, for a step that goes on with the rounds it holds. */
export const roundOf = (implId: number, id: number, r: NewRound, at: string): ImplementationRound =>
  ({ id, implementationId: implId, kind: r.kind, callId: r.callId ?? null, result: r.result ?? null, at });
