// Releases (operator, or maintainer with write) on the Item page: review again, verify again, try the fix again.
// They change local tables only; the pipeline picks the item up on its next pass. `stopFixItem` runs the item commands.
import { ActionError, batchAgain, reviewAgain, verifyAgain } from "../../operator-actions.ts";
import { loadItems } from "../../data/mirror/index.ts";
import { parse } from "../../workflow/parse.ts";
import { runCommand } from "../../workflow/apply.ts";
import { cancelPreapproval, preapprovalOf } from "../../preapproval/index.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { allVisibleRepos, needVisible } from "./visible.ts";
import type { Db } from "../../db/index.ts";
import { mayRunRepo } from "../repo-access.ts";

async function run(db: Db, req: Req, f: (db: Db, by: string, repo: string, n: number) => Promise<void>): Promise<{ ok: true }> {
  const repo = req.params.repo!;
  if (!(await mayRunRepo(req.user, repo))) throw new HttpError(403, "no write access to this repo");
  const n = Number(req.params.n);
  if (!Number.isInteger(n)) throw new HttpError(400, "not an item number");
  await needVisible(db, req, repo);
  try {
    await f(db, req.user.login, repo, n);
  } catch (e) {
    if (e instanceof ActionError) throw new HttpError(e.status, e.message);
    throw e;
  }
  return { ok: true };
}

/** Operator: cancels the PR's pre-approved merge while it is before the merge queue's merge. */
export async function cancelItemPreapproval(db: Db, req: Req, via?: string) {
  const repo = req.params.repo!;
  if (!(await mayRunRepo(req.user, repo))) throw new HttpError(403, "no write access to this repo");
  const n = Number(req.params.n);
  if (!Number.isInteger(n)) throw new HttpError(400, "not an item number");
  await needVisible(db, req, repo);
  try {
    return await cancelPreapproval(db, req.user.login, repo, n, undefined, via);
  } catch (e) {
    throw new HttpError(409, (e as Error).message);
  }
}

/** The PR's failed pre-approved merge again, at its current head: the `fix-up and merge` command (`merge` for one that had no fix-up) runs as the signed-in person. */
export async function retryItemPreapproval(db: Db, req: Req) {
  const repo = req.params.repo!;
  const n = Number(req.params.n);
  if (!Number.isInteger(n)) throw new HttpError(400, "not an item number");
  await needVisible(db, req, repo);
  const p = await preapprovalOf(db, repo, n);
  if (p?.state !== "failed") throw new HttpError(409, `${repo}#${n} has no failed pre-approved merge`);
  await runAs(db, req, repo, n, p.instructions ? "fix-up, merge" : "merge");
  return await preapprovalOf(db, repo, n);
}

/** Runs a command on the item as the signed-in person; one that did not run is an error with its line. */
async function runAs(db: Db, req: Req, repo: string, n: number, text: string): Promise<void> {
  const actor = { login: req.user.login, canWrite: (r: string) => req.user.canWrite(r) };
  const visible = new Set(await allVisibleRepos(db, req));
  const res = await runCommand(db, actor, "dashboard", { parsed: parse(text, { repo }), items: [{ repo, number: n }], visible: async (r) => visible.has(r) });
  const out = res.items[0];
  if (!out || out.outcome !== "run") throw new HttpError(409, out?.line ?? res.lines[0] ?? `${repo}#${n} was not changed`);
}

/** Puts an issue whose fix stopped in the Backlog or closes it: the `backlog` and `close` commands run as the signed-in person. */
export async function stopFixItem(db: Db, req: Req): Promise<{ ok: true }> {
  const repo = req.params.repo!;
  const n = Number(req.params.n);
  if (!Number.isInteger(n)) throw new HttpError(400, "not an item number");
  await needVisible(db, req, repo);
  const answer = (req.json as { answer?: unknown } | undefined)?.answer;
  if (answer !== "close" && answer !== "backlog") throw new HttpError(400, "answer must be close or backlog");
  const it = (await loadItems(db, [{ repo, number: n }], "ref")).get(`${repo}#${n}`);
  if (!it || it.kind !== "issue" || it.state !== "OPEN") throw new HttpError(409, `${repo}#${n} is not an open issue`);
  await runAs(db, req, repo, n, answer);
  return { ok: true };
}

export const reviewItemAgain = async (db: Db, req: Req) => run(db, req, reviewAgain);
export const verifyItemAgain = async (db: Db, req: Req) => run(db, req, verifyAgain);
export const batchItemAgain = async (db: Db, req: Req) => run(db, req, batchAgain);
