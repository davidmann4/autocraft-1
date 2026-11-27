// reads: (none; composes loaders)
// The implementation panel's data: the issue's current (or newest ended) attempt with its rounds, the model calls the rounds name
// (call id, then run), the warm notes of its workspaces and, when it asked a question, the issue's comments.
import type { Db } from "../../db/index.ts";
import { loadWorkspaceWarm } from "../build/index.ts";
import { loadImplementationView } from "../implement/index.ts";
import type { ImplementationView } from "../implement/types.ts";
import { loadRunsById } from "../inference/index.ts";
import type { RunRow } from "../inference/types.ts";
import { loadComments } from "../mirror/index.ts";
import type { CommentOut } from "../mirror/types.ts";
import { loadRunIdsOfCalls } from "../runners/index.ts";
import type { WarmNote } from "../build/types.ts";

export type ImplementationFacts = {
  view: ImplementationView;
  /** Run id of each call id the attempt names. */
  runIds: Map<number, number>; runs: Map<number, RunRow>; warm: Map<number, WarmNote>;
  /** The issue's comments, when an attempt asked a question (and none were given). */
  comments: CommentOut[];
};

/** The call ids the attempt and its rounds name, and the workspaces it used. */
export const callIdsOf = (v: ImplementationView): number[] =>
  [...new Set([v.impl.planCallId, v.impl.sessionCallId, ...v.rounds.map((r) => r.callId)].filter((x): x is number => x !== null))];
export const workspaceIdsOf = (v: ImplementationView): number[] =>
  [...new Set([v.impl.workspaceId, ...v.rounds.map((r) => (r.kind === "workspace" ? (r.result as { workspaceId?: unknown } | null)?.workspaceId : null))].filter((x): x is number => typeof x === "number"))];

/** Null when the issue has no attempt. `comments`, when the caller already holds them, are used instead of a read. */
export async function loadItemImplementation(db: Db, ref: { repo: string; number: number }, comments?: CommentOut[]): Promise<ImplementationFacts | null> {
  const key = `${ref.repo}#${ref.number}`;
  const view = await loadImplementationView(db, key);
  return view ? await completeImplementation(db, ref, view, comments) : null;
}

/** The second and third waves, for a caller that read the view in its own first wave. */
export async function completeImplementation(db: Db, ref: { repo: string; number: number }, view: ImplementationView, comments?: CommentOut[]): Promise<ImplementationFacts> {
  const asked = view.rounds.some((r) => r.kind === "question");
  const [runIds, warm, found] = await db.together(() => Promise.all([
    loadRunIdsOfCalls(db, callIdsOf(view)), loadWorkspaceWarm(db, workspaceIdsOf(view)),
    asked && !comments ? loadComments(db, [ref], { order: "created", body: true, excludeBots: true }) : Promise.resolve(new Map<string, CommentOut[]>()),
  ]));
  const runs = await loadRunsById(db, [...new Set(runIds.values())]);
  return { view, runIds, runs, warm, comments: comments ?? found.get(`${ref.repo}#${ref.number}`) ?? [] };
}
