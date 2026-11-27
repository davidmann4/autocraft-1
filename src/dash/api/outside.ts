// The outside-author protections over JSON (src/outside.ts): the three numbers, and the operator's releases.
import { listHeldAuthors } from "../../data/intake/index.ts";
import type { HeldAuthor } from "../../../web/src/api/types.ts";
import { OutsideError, releaseAuthor, releaseOutside, setOutsideLimits } from "../../outside.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { hiddenRepos, needVisible } from "./visible.ts";
import type { Db } from "../../db/index.ts";
import { mayRunRepo } from "../repo-access.ts";
import { blockerThresholds, setBlockerThresholds, ThresholdError } from "../../workflow/settings.ts";

const operator = (req: Req, what: string): void => {
  if (req.user.role !== "operator") throw new HttpError(403, `only operators ${what}`);
};

const wrap = async <T>(f: () => Promise<T>): Promise<T> => {
  try {
    return await f();
  } catch (e) {
    if (e instanceof OutsideError) throw new HttpError(e.status, e.message);
    throw e;
  }
};

/** The maintainer workflow's threshold for the blocker of a change outside the purpose. */
export async function getBlockerThresholds(db: Db) {
  return await blockerThresholds(db);
}

/** Operator: sets the blocker thresholds, an instance setting. */
export async function putBlockerThresholds(db: Db, req: Req) {
  operator(req, "change the blocker thresholds");
  try {
    return await setBlockerThresholds(db, req.user.login, req.json);
  } catch (e) {
    if (e instanceof ThresholdError) throw new HttpError(400, e.message);
    throw e;
  }
}

/** Operator: sets the daily budgets and the surge threshold; 0 turns a protection off. */
export async function putLimits(db: Db, req: Req) {
  operator(req, "change the outside-author limits");
  return await wrap(async () => await setOutsideLimits(db, req.user.login, req.json));
}

/** Exempts one held item; the requester must run the repo. */
export async function release(db: Db, req: Req) {
  const repo = req.params.repo!;
  if (!(await mayRunRepo(req.user, repo))) throw new HttpError(403, "no write access to this repo");
  const n = Number(req.params.n);
  if (!Number.isInteger(n)) throw new HttpError(400, "not an item number");
  await needVisible(db, req, repo);
  await wrap(async () => await releaseOutside(db, req.user.login, repo, n));
  return { ok: true };
}

/** Operator: exempts every item now held for one author. */
export async function releaseAll(db: Db, req: Req) {
  operator(req, "release items");
  const author = (req.json as { author?: unknown } | null)?.author;
  if (typeof author !== "string" || !/^[A-Za-z0-9\[\]-]{1,60}$/.test(author)) throw new HttpError(400, "author must be a login");
  return { released: await wrap(async () => await releaseAuthor(db, req.user.login, author)) };
}

/** Operator: the authors with held items, most items first. */
export async function held(db: Db, req: Req): Promise<HeldAuthor[]> {
  operator(req, "see the held authors");
  return (await listHeldAuthors(db, { hidden: await hiddenRepos(db, req) })).map((r) => ({ author: r.author, prs: r.prs, issues: r.count - r.prs, oldest: r.oldest, surge: r.surge }));
}
