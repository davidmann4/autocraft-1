// Agent runs and rates over JSON; everyone signed in reads. Refused runs and their counts are for operators and maintainers.
import type { AgentRunFilter, AgentRunState, RefusalWindow } from "../../../web/src/api/types.ts";
import { getRun, listRuns, rates as ratesOf, refusals as refusalsOf, RunQueryError } from "../../agents/runs.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { hiddenRepos } from "./visible.ts";
import { canSeeInternals } from "./staff.ts";
import { SECURITY_STEP } from "../../security/rules.ts";
import type { Db } from "../../db/index.ts";
import type { Res } from "../types.ts";
import { loadRunTranscripts, loadTranscript, type TranscriptRow } from "../../data/inference/index.ts";
import { saveStore, storeStatus, summaryOf, testStore, transcriptObject, transcriptsOn, transcriptView } from "../../transcripts/index.ts";

const wrap = async <T>(f: () => Promise<T | Promise<T>>): Promise<T> => {
  try {
    return await f();
  } catch (e) {
    if (e instanceof RunQueryError) throw new HttpError(e.status, e.message);
    throw e;
  }
};

function intParam(req: Req, name: string): number | undefined {
  const v = req.query.get(name);
  if (v === null || v === "") return undefined;
  if (!/^\d{1,6}$/.test(v)) throw new HttpError(400, `${name} must be a whole number`);
  return Number(v);
}

export const list = async (db: Db, req: Req) => wrap(async () => {
  const q = (k: string) => req.query.get(k) || undefined;
  const f: AgentRunFilter = {
    state: q("state") as AgentRunState | "recent" | undefined, step: q("step"), repo: q("repo"), cursor: q("cursor"), limit: intParam(req, "limit"),
    refused: req.query.get("refused") === "1" || undefined, window: q("window") as RefusalWindow | undefined,
  };
  return await listRuns(db, f, await hiddenRepos(db, req), canSeeInternals(req));
});

// The prompt and output texts hold item and comment text verbatim: operators and maintainers only.
export const detail = async (db: Db, req: Req) => wrap(async () => {
  if (!/^\d{1,15}$/.test(req.params.id ?? "")) throw new HttpError(400, "not a run id");
  const staff = canSeeInternals(req);
  const run = await getRun(db, Number(req.params.id), { hidden: await hiddenRepos(db, req), texts: staff });
  if (!staff) return run;
  return { ...run, transcripts: (await loadRunTranscripts(db, run.id)).map(summaryOf), ...(!(await transcriptsOn(db)) && { transcriptsOff: true }) };
});

/** A transcript the requester may read: operators and maintainers, of a run in a repo they see. Throws HttpError. */
async function readable(db: Db, req: Req): Promise<TranscriptRow> {
  if (!canSeeInternals(req)) throw new HttpError(403, "only operators and maintainers read transcripts");
  if (!/^\d{1,15}$/.test(req.params.id ?? "") || !/^\d{1,15}$/.test(req.params.tid ?? "")) throw new HttpError(400, "not a transcript id");
  const run = await wrap(async () => await getRun(db, Number(req.params.id), { hidden: await hiddenRepos(db, req), texts: false }));
  const t = await loadTranscript(db, run.id, Number(req.params.tid));
  if (!t) throw new HttpError(404, `run ${run.id} has no transcript ${req.params.tid}`);
  return t;
}

// The transcript reads ask the store (a bucket, for most instances), so their routes run outside `db.together`.
export const transcript = async (db: Db, req: Req) => {
  const t = await readable(db, req);
  try { return await transcriptView(db, t); } catch (e) { throw new HttpError(502, (e as Error).message); }
};

/** The stored gzip JSONL as a file. */
export async function transcriptDownload(db: Db, req: Req): Promise<Res> {
  try {
    const t = await readable(db, req);
    let body: Buffer;
    try { body = await transcriptObject(db, t); } catch (e) { throw new HttpError(502, (e as Error).message); }
    return { body, headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="run-${t.runId}-transcript-${t.id}.jsonl.gz"`, "x-content-type-options": "nosniff", "cache-control": "private, no-cache" } };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, json: { error: e.message } };
    throw e;
  }
}

// Admin: where transcripts are stored (operator routes).
export const storeGet = async (db: Db) => await storeStatus(db);
export const storePut = async (db: Db, req: Req) => {
  try { await saveStore(db, req.json ?? null, req.user.login); } catch (e) { throw new HttpError(400, (e as Error).message); }
  return await storeStatus(db);
};
export const storeClear = async (db: Db, req: Req) => {
  await saveStore(db, null, req.user.login);
  return await storeStatus(db);
};
export const storeTest = async (db: Db, req: Req) => await testStore(db, req.json && typeof req.json === "object" && Object.keys(req.json).length ? req.json : null);

export const rates = async (db: Db, req: Req) => wrap(async () => {
  const r = await ratesOf(db, req.query.get("window") ?? "24h", Date.now(), await hiddenRepos(db, req));
  return canSeeInternals(req) ? r : { ...r, stages: r.stages.filter((s) => s.step !== SECURITY_STEP) };
});

// Which runs a safety filter declined, by whom and on what: operators and maintainers only, like the errors themselves.
export const refusals = async (db: Db, req: Req) => wrap(async () => {
  if (!canSeeInternals(req)) throw new HttpError(403, "operators and maintainers only");
  return await refusalsOf(db, req.query.get("window") ?? "7d", await hiddenRepos(db, req));
});
