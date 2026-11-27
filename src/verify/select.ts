// The PRs Verify plans: those whose Plan holds a `verify` action (a take at the current head, CI not failing, not verified yet).
import { CLI_BY, type By } from "../core/gates.ts";
import { planned } from "../core/select.ts";
import type { ReviewInfo, VerifyCandidate } from "./candidates.ts";
import { loadItems } from "../data/mirror/index.ts";
import { loadReviewsAt } from "../data/review/index.ts";
import type { Db } from "../db/index.ts";

/** The PRs to plan and build, in selection order. */
export async function selectCandidates(db: Db, repo: string | undefined, run?: string | null, by?: By): Promise<VerifyCandidate[]> {
  return (await candidatesIn(db, "plan", repo, run, by)).map((x) => x.c);
}

/** The PRs Verify cannot build (private repo, or no Cargo.toml at the root of a repo without CI), with why. */
export async function unavailableCandidates(db: Db, repo: string | undefined, run?: string | null, by?: By): Promise<{ c: VerifyCandidate; reason: string }[]> {
  return (await candidatesIn(db, "unavailable", repo, run, by)).map((x) => ({ c: x.c, reason: x.reason! }));
}

async function candidatesIn(db: Db, bucket: "plan" | "unavailable", repo: string | undefined, run: string | null | undefined, by: By = CLI_BY): Promise<{ c: VerifyCandidate; reason: string | null }[]> {
  const list = await planned(db, "verify", { bucket, by, ...(repo ? { repo } : {}), ...(run !== undefined ? { run } : {}) });
  const [reviews, items] = await db.together(() => Promise.all([
    loadReviewsAt(db, list.map(({ facts: f, action }) => ({ repo: f.repo, number: f.number, head: action.head! }))),
    loadItems(db, list.map(({ facts: f }) => ({ repo: f.repo, number: f.number })), "text"),
  ]));
  return list.map(({ facts: f, action }) => {
    const r = reviews.get(`${f.repo}#${f.number}@${action.head!}`);
    const t = items.get(`${f.repo}#${f.number}`);
    const info: ReviewInfo = { verdict: r?.verdict ?? "take", reason: r?.reason ?? "", risks: r?.risks ?? [], fixes: r?.fixes ?? [] };
    return { c: { repo: f.repo, number: f.number, title: t?.title ?? "", body: t?.body ?? "", head_oid: action.head!, label: f.label, review: info }, reason: f.verifyUnavailable };
  });
}
