// The sessions of workspaces with the cost and reply of their model calls, for the Workspaces list and page.
import type { Db } from "../../db/index.ts";
import * as build from "../build/index.ts";
import * as runners from "../runners/index.ts";

export type SessionCostRow = { workspaceId: number; item: number | null; usage: string | null };
export type SessionDetailRow = {
  id: number; kind: string | null; item: number; state: string; outcome: string | null; forLogin: string | null; requestedBy: string | null; createdAt: string;
  endedAt: string | null; jobId: number | null; prompt: string | null; reply: string | null; usage: string | null;
};

/** Only what the cost needs, oldest session first: the list never reads prompts or replies. 2 statements. */
export async function loadSessionCosts(db: Db, workspaceIds: number[]): Promise<Map<number, SessionCostRow[]>> {
  const out = new Map<number, SessionCostRow[]>();
  const sessions = await build.loadSessionCalls(db, workspaceIds);
  const usage = await runners.loadCallUsage(db, [...new Set([...sessions.values()].flat().flatMap((r) => (r.remoteCallId === null ? [] : [r.remoteCallId])))]);
  for (const [id, rows] of sessions) out.set(id, rows.map((r) => ({ workspaceId: id, item: r.item, usage: r.remoteCallId === null ? null : usage.get(r.remoteCallId)?.usage ?? null })));
  return out;
}

/** One workspace's sessions with prompt, reply and usage, oldest first. 2 statements. */
export async function loadSessionDetails(db: Db, workspaceId: number): Promise<SessionDetailRow[]> {
  const rows = (await build.loadSessions(db, { workspaceIds: [workspaceId] })).get(workspaceId) ?? [];
  const calls = await runners.loadCallUsage(db, [...new Set(rows.flatMap((r) => (r.remote_call_id === null ? [] : [Number(r.remote_call_id)])))], { reply: true });
  return rows.map((r) => {
    const c = r.remote_call_id === null ? undefined : calls.get(Number(r.remote_call_id));
    return {
      id: Number(r.id), kind: r.kind, item: Number(r.item), state: r.state, outcome: r.outcome, forLogin: r.for_login, requestedBy: r.requested_by, createdAt: r.created_at,
      endedAt: r.ended_at, jobId: r.job_id === null ? null : Number(r.job_id), prompt: r.prompt, reply: c?.reply ?? null, usage: c?.usage ?? null,
    };
  });
}
