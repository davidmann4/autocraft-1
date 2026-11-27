// The self-evaluation's reads (what the detectors look at) and its causes table (eval_causes).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import type { EvalCause, EvalCauseState, EvalEvidence, EvalFacts, EvalLoginRole, EvalNames, EvalVerdict } from "./types.ts";

export type * from "./types.ts";

const LIVE = ["running", "waiting", "blocked", "recommending"];
const ANSWER_KINDS = ["answered", "approved", "started"];

const iso = (ms: number): string => new Date(ms).toISOString();
const refsOf = (s: string | null): { repo: string; number: number }[] => {
  try {
    const v = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is { repo: string; number: number } => !!x && typeof x.repo === "string" && Number.isInteger(x.number)) : [];
  } catch { return []; }
};

/**
 * Everything the detectors read, in one wave: live workflows, queued calls and the Task Runners, queued and running jobs,
 * jobs that ended since `sinceMs`, audit rows since then (only the error and step of their details), answers since then
 * with whether a job touched the item after them, and PRs merged since `mergedSinceMs` with their Claude calls by prompt.
 */
export async function loadEvalFacts(db: Db, o: { sinceMs: number; mergedSinceMs: number }): Promise<EvalFacts> {
  const q = queryDb(db);
  const since = iso(o.sinceMs);
  const [wf, calls, runners, live, ended, audit, answers, merged] = await db.together(() => Promise.all([
    q.all(q.k.selectFrom("item_workflows").select(["id", "repo", "number", "state", "step", "blocker", "rec", "updated_at"]).where(kx.inList(db, "state", LIVE))),
    q.all(q.k.selectFrom("remote_calls").select(["id", "job_id", "step", "prompt_id", "repo", "queued_since", "no_taker_since", "items"]).where("state", "=", "queued")),
    q.all(q.k.selectFrom("remote_helpers").select(["readiness", "reported_at", "slots", "busy"])),
    q.all(q.k.selectFrom("jobs").select(["id", "step", "repo", "state", "requested_at", "started_at"]).where(kx.inList(db, "state", ["queued", "running"]))),
    q.all(q.k.selectFrom("jobs").select(["id", "step", "repo", "state", "error", "items", "acted", "ended_at"]).where(kx.inList(db, "state", ["done", "failed"])).where("ended_at", ">=", since)),
    q.all(q.k.selectFrom("audit").select([kx.rowid("audit").as("rowid"), "at", "action", "target", kx.jsonText(db, "details", "$.error").as("error"), kx.jsonText(db, "details", "$.step").as("step")]).where("at", ">=", since)),
    q.all(q.k.selectFrom("workflow_events as e").select((eb) => ["e.id", "e.repo", "e.number", "e.kind", "e.at",
      eb.exists(eb.selectFrom("item_workflows as w").select(eb.lit(1).as("one")).whereRef("w.repo", "=", "e.repo").whereRef("w.number", "=", "e.number").where(kx.inList(db, "w.state", LIVE))).as("live"),
      eb.exists(eb.selectFrom("job_items as ji").select(eb.lit(1).as("one")).whereRef("ji.repo", "=", "e.repo").whereRef("ji.number", "=", "e.number").whereRef("ji.at", ">", "e.at")).as("touched")])
      .where(kx.inList(db, "e.kind", ANSWER_KINDS)).where("e.at", ">=", since)),
    q.all(q.k.selectFrom("items as i").innerJoin("agent_run_items as ari", (j) => j.onRef("ari.repo", "=", "i.repo").onRef("ari.number", "=", "i.number"))
      .innerJoin("agent_runs as ar", "ar.id", "ari.run_id")
      .select((eb) => ["i.repo", "i.number", "i.merged_at", "ar.prompt_id", eb.fn.countAll<number>().as("calls"), eb.fn.sum<number | null>("ar.cost_usd").as("cost")])
      .where("i.kind", "=", "pr").where("i.state", "=", "MERGED").where("i.merged_at", ">=", iso(o.mergedSinceMs)).where("ar.provider", "=", "claude")
      .groupBy(["i.repo", "i.number", "i.merged_at", "ar.prompt_id"])),
  ]));
  const byPr = new Map<string, EvalFacts["merged"][number]>();
  for (const r of merged) {
    const k = `${r.repo}#${r.number}`;
    const m = byPr.get(k) ?? byPr.set(k, { repo: r.repo, number: Number(r.number), mergedAt: r.merged_at ?? "", calls: 0, costUsd: 0, byPrompt: {} }).get(k)!;
    m.calls += Number(r.calls); m.costUsd += Number(r.cost ?? 0); m.byPrompt[r.prompt_id] = Number(r.calls);
  }
  return {
    workflows: wf.map((r) => ({ id: Number(r.id), repo: r.repo, number: Number(r.number), state: r.state, step: r.step, blocker: r.blocker, rec: r.rec, updatedAt: r.updated_at })),
    queuedCalls: calls.filter((r) => r.queued_since !== null).map((r) => ({ id: Number(r.id), jobId: r.job_id === null ? null : Number(r.job_id), step: r.step, promptId: r.prompt_id, repo: r.repo, queuedSince: Number(r.queued_since), noTakerSince: r.no_taker_since === null ? null : Number(r.no_taker_since), refs: refsOf(r.items) })),
    runners: runners.map((r) => ({ readiness: r.readiness, reportedAt: Number(r.reported_at), slots: r.slots === null ? null : Number(r.slots), busy: r.busy === null ? null : Number(r.busy) })),
    liveJobs: live.map((r) => ({ id: Number(r.id), step: r.step, repo: r.repo, state: r.state as "queued" | "running", requestedAt: r.requested_at, startedAt: r.started_at })),
    endedJobs: ended.map((r) => ({ id: Number(r.id), step: r.step, repo: r.repo, state: r.state, error: r.error, items: Number(r.items ?? 0), acted: Number(r.acted ?? 0), endedAt: r.ended_at ?? "" })),
    audit: audit.map((r) => ({ rowid: Number(r.rowid), at: r.at, action: r.action, target: r.target, error: r.error === null ? null : String(r.error), step: r.step === null ? null : String(r.step) })),
    answers: answers.map((r) => ({ id: Number(r.id), repo: r.repo, number: Number(r.number), kind: r.kind, at: r.at, live: Boolean(Number(r.live)), touchedAfter: Boolean(Number(r.touched)) })),
    merged: [...byPr.values()],
  };
}

const RANK: Record<EvalLoginRole, number> = { operator: 0, maintainer: 1, runner: 2, user: 3, owner: 4, author: 5 };
const hostOf = (machine: string | null): string | null => {
  try {
    const h = (JSON.parse(machine ?? "null") as { hostname?: unknown } | null)?.hostname;
    return typeof h === "string" && h.trim() ? h.trim() : null;
  } catch { return null; }
};

/**
 * Every login AutoCraft knows with its strongest role (access list, Task Runner credentials and helpers, user settings,
 * repository owners, item authors and mergers; bots left out), and the host names and labels of Task Runner machines.
 */
export async function loadEvalNames(db: Db): Promise<EvalNames> {
  const q = queryDb(db);
  const [access, tokens, helpers, logins, settings, owners, authors, mergers] = await db.together(() => Promise.all([
    q.all(q.k.selectFrom("access").select(["login", "role"])),
    q.all(q.k.selectFrom("mcp_tokens").select(["login", "kind", "label", "machine"])),
    q.all(q.k.selectFrom("remote_helpers").select(["login", "machine"])),
    q.all(q.k.selectFrom("runner_logins").select(["login", "label", "machine"])),
    q.all(q.k.selectFrom("user_settings").select("login").distinct()),
    q.all(q.k.selectFrom("repos").select("owner").distinct()),
    q.all(q.k.selectFrom("items").select("author").distinct().where("author", "is not", null).where((eb) => eb.or([eb("author_type", "is", null), eb("author_type", "!=", "Bot")]))),
    q.all(q.k.selectFrom("items").select("merged_by").distinct().where("merged_by", "is not", null)),
  ]));
  const roles = new Map<string, { login: string; role: EvalLoginRole }>();
  const add = (login: string | null, role: EvalLoginRole) => {
    const l = login?.trim();
    if (!l || /\[bot\]$/i.test(l) || l.toLowerCase() === "ghost") return;
    const was = roles.get(l.toLowerCase());
    if (!was || RANK[role] < RANK[was.role]) roles.set(l.toLowerCase(), { login: l, role });
  };
  for (const r of access) add(r.login, r.role === "operator" ? "operator" : r.role === "maintainer" ? "maintainer" : "user");
  for (const r of tokens) add(r.login, r.kind === "runner" ? "runner" : "user");
  for (const r of helpers) add(r.login, "runner");
  for (const r of logins) add(r.login, "runner");
  for (const r of settings) add(r.login, "user");
  for (const r of owners) add(r.owner, "owner");
  for (const r of authors) add(r.author, "author");
  for (const r of mergers) add(r.merged_by, "author");
  const hosts = new Set<string>(), labels = new Set<string>();
  for (const r of [...tokens, ...helpers, ...logins]) { const h = hostOf(r.machine); if (h) hosts.add(h); }
  for (const r of [...tokens, ...logins]) { const l = r.label?.trim(); if (l) labels.add(l); }
  return { logins: [...roles.values()], hosts: [...hosts], labels: [...labels] };
}

// ---- causes ----------------------------------------------------------------------------------------------------------

type Raw = {
  cause_key: string; detector: string; summary: string; state: string; first_seen: string; last_seen: string; evidence: string; seen: number | string;
  investigated_at: string | null; investigated_seen: number | string; verdict: string | null; failures: number | string; finding: string | null; model: string | null; run_id: string | null;
  issue_number: number | string | null; filed_at: string | null; reported_seen: number | string; commented_at: string | null; attempts: number | string; note: string | null;
};
const parse = <T,>(s: string | null, dflt: T): T => { try { return s === null ? dflt : JSON.parse(s) as T; } catch { return dflt; } };
const causeOf = (r: Raw): EvalCause => ({
  key: r.cause_key, detector: r.detector, summary: r.summary, state: r.state as EvalCauseState, firstSeen: r.first_seen, lastSeen: r.last_seen,
  evidence: parse<EvalEvidence[]>(r.evidence, []), seen: Number(r.seen), investigatedAt: r.investigated_at, investigatedSeen: Number(r.investigated_seen),
  verdict: r.verdict as EvalVerdict | null, failures: Number(r.failures ?? 0), finding: parse<unknown>(r.finding, null), model: r.model, runId: r.run_id,
  issueNumber: r.issue_number === null ? null : Number(r.issue_number), filedAt: r.filed_at, reportedSeen: Number(r.reported_seen), commentedAt: r.commented_at,
  attempts: Number(r.attempts), note: r.note,
});
const rowOf = (c: EvalCause) => ({
  cause_key: c.key, detector: c.detector, summary: c.summary, state: c.state, first_seen: c.firstSeen, last_seen: c.lastSeen, evidence: JSON.stringify(c.evidence), seen: c.seen,
  investigated_at: c.investigatedAt, investigated_seen: c.investigatedSeen, verdict: c.verdict, failures: c.failures, finding: c.finding === null || c.finding === undefined ? null : JSON.stringify(c.finding),
  model: c.model, run_id: c.runId, issue_number: c.issueNumber, filed_at: c.filedAt, reported_seen: c.reportedSeen, commented_at: c.commentedAt, attempts: c.attempts, note: c.note,
});

/** The stored causes, all or those of `keys`, by key. */
export async function loadEvalCauses(db: Db, keys?: readonly string[]): Promise<Map<string, EvalCause>> {
  if (keys && !keys.length) return new Map();
  const q = queryDb(db);
  const out = new Map<string, EvalCause>();
  const base = q.k.selectFrom("eval_causes").selectAll();
  for (const part of keys ? kx.chunks(keys) : [null]) {
    for (const r of await q.all(part ? base.where(kx.inList(db, "cause_key", part)) : base)) out.set(r.cause_key, causeOf(r as Raw));
  }
  return out;
}

/** Writes whole cause rows (insert or replace by key). */
export async function saveEvalCauses(db: Db, causes: readonly EvalCause[]): Promise<void> {
  if (!causes.length) return;
  await db.write(async () => { await kx.replaceRows(db, "main.eval_causes", ["cause_key"], causes.map(rowOf)); });
}

/** Moves a cause to `filing` (filed_at holds when) when it is still in `from`; false when another process moved it first. */
export async function claimEvalFiling(db: Db, key: string, from: EvalCauseState, attempts: number, at: string): Promise<boolean> {
  const q = queryDb(db);
  const r = await db.write(() => q.run(q.k.updateTable("main.eval_causes").set({ state: "filing", attempts, filed_at: at }).where("cause_key", "=", key).where("state", "=", from)));
  return Number(r.changes) > 0;
}
