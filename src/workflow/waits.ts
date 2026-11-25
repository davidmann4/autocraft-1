// What an approved workflow's merge leg waits for when nothing can move it on: the pre-merge check of the PR's head, due once the
// leg is in `ci`, with no Task Runner that may take it, or only the approver's own runners, none of which can claim now
// (src/remote/takers.ts waitingOn). The status comment, the item page and the agent show it as the state line.
import type { Db } from "../db/index.ts";
import { t, tk } from "../i18n/index.ts";
import { PREMERGE_MAX_TRIES, premergeAt } from "../premerge/store.ts";
import { mergeDecisionId } from "../core/rules.ts";
import { inferenceMode } from "../remote/mode.ts";
import { takerTest, waitingOn, type RunnerHold } from "../remote/takers.ts";
import type { ItemWorkflow } from "./types.ts";

/**
 * The state line of a workflow whose merge leg waits for a pre-merge check that no Task Runner can take, or that only the own
 * runners of the people whose work it is take while none of them can claim (offline, held for its usage, cooling off); else null.
 */
export async function legWait(db: Db, wf: Pick<ItemWorkflow, "id" | "repo" | "state">, nowMs: number = Date.now()): Promise<string | null> {
  if (wf.state !== "running" && wf.state !== "waiting") return null;
  const p = await db.get(db.k.selectFrom("main.preapprovals").select(["number", "head"]).where("workflow_id", "=", wf.id).where("state", "=", "ci").orderBy("id", "desc").limit(1));
  if (p?.head) {
    const d = await db.get(db.k.selectFrom("main.decisions").select(["exec_state", "answered_by"]).where("id", "=", mergeDecisionId(wf.repo, p.number, p.head)));
    if (d?.exec_state === "waiting-token" && d.answered_by) return t("Waiting for {login} to sign in to AutoCraft, so the merge runs as them", { login: d.answered_by });
  }
  if (!p?.head || await inferenceMode(db) !== "user-local") return null;
  const pm = await premergeAt(db, wf.repo, p.number, p.head);
  if (pm && (pm.findings !== null || pm.tries >= PREMERGE_MAX_TRIES)) return null;
  const call = { prompt_id: "", repos: [wf.repo], step: "premerge", refs: [{ repo: wf.repo, number: p.number }] };
  if (!await takerTest(db, nowMs)(call)) return t("Waiting for the pre-merge check: no Task Runner can take it");
  const [first] = await waitingOn(db, call, nowMs);
  return first ? t("Waiting for {login}'s Task Runner ({why})", { login: first.login, why: t(HOLD_WORD[first.hold]) }) : null;
}

const HOLD_WORD: Record<RunnerHold, string> = { offline: tk("offline"), "usage-limit": tk("usage limit"), "cooling-off": tk("cooling off"), "not-ready": tk("not ready") };
