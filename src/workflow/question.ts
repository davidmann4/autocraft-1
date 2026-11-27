// What an implementation asks the maintainers, as the issue's workflow shows it: an open question of a plan (with the question after
// the last round of questions) or a stuck implementation becomes one recommendation, with the question's options as numbered parts.
// A yes answers with the recommended option; naming a part, by number or words, picks that one. Pure: advance.ts gives it the
// attempt, and apply.ts records the answer on it.
import type { IssueAttempt } from "../data/implement/types.ts";
import { t } from "../i18n/index.ts";
import { STUCK_CAUSES, STUCK_OPTIONS, type StuckCause } from "../implement/stuck.ts";
import type { PlanReply } from "../implement/types.ts";
import { sameQuestion, type PlanPart, type QuestionRef, type Recommendation } from "./types.ts";

/** The question the maintainers have not answered yet, or null (an author's question is answered on the issue). */
export function openQuestionOf(a: IssueAttempt | null | undefined): QuestionRef | null {
  if (!a?.question || a.answer !== null || a.question.audience !== "maintainer") return null;
  return { implementation: a.attempt.id, round: a.question.round };
}

/** `q` is still the attempt's open question: not answered, and no newer attempt or round took its place. */
export const isOpenQuestion = (a: IssueAttempt | null | undefined, q: QuestionRef): boolean => sameQuestion(openQuestionOf(a), q);

/** The question a recommendation stands for; null for any other recommendation. */
export const askedBy = (rec: Recommendation | null): QuestionRef | null => rec?.question ?? rec?.answer?.question ?? null;

/** The question's options as numbered parts; an option a person dropped before (same title) stays dropped. */
function optionParts(a: IssueAttempt, q: QuestionRef, before: readonly PlanPart[]): PlanPart[] {
  const dropped = new Set(before.filter((p) => p.option !== undefined && p.state === "dropped").map((p) => p.title.toLowerCase()));
  return a.question!.options.map((o, i) => ({
    n: i + 1, title: o.label, source: "implement" as const, option: o.key, question: q, state: dropped.has(o.label.toLowerCase()) ? "dropped" as const : "planned" as const,
  }));
}

const droppedOf = (plan: readonly PlanPart[]): number[] => plan.filter((p) => p.state === "dropped").map((p) => p.n);
const exampleOf = (plan: readonly PlanPart[]): number => plan.find((p) => p.state === "planned")?.n ?? 1;

export type AskedView = { plan: PlanPart[]; rec: Recommendation };

/**
 * An open question of the plan. The plan's own sentence is used when the one option number it names is the one a yes answers. A
 * question with no recommended option, or one only words answer, gets a recommendation a yes cannot run: the person names an option
 * or comments on the issue.
 */
function askedView(a: IssueAttempt, q: QuestionRef, before: readonly PlanPart[], approved: boolean): AskedView {
  const asked = a.question!;
  const plan = optionParts(a, q, before);
  const parts = { fix: [], drop: droppedOf(plan) };
  const pick = plan.find((p) => p.option === asked.recommended && p.state === "planned");
  if (!pick) {
    const text = plan.length
      ? t("Answer the question “{question}” by naming the option to go with, such as “{n}”.", { question: asked.text, n: exampleOf(plan) })
      : t("Answer the question “{question}” in a comment on the issue; the plan runs again with the answer.", { question: asked.text });
    return { plan, rec: { text, parts, merges: false, question: q } };
  }
  const own = asked.limit ? null : (a.planned?.plan as PlanReply | null | undefined)?.workflow?.recommendation ?? null;
  const named = own ? [...new Set([...own.matchAll(/\b(\d+)\b/g)].map((m) => Number(m[1])).filter((n) => n >= 1 && n <= plan.length))] : [];
  const text = own && named.length === 1 && named[0] === pick.n ? own
    : asked.limit ? t("Implement it with the stated assumptions, though the plan still has open questions.")
    : t("Go with {n}, {title}, then implement it.", { n: pick.n, title: pick.title });
  return { plan, rec: { text, parts, merges: approved, answer: { question: q, option: pick.option!, label: pick.title }, question: q } };
}

/**
 * A stuck implementation: a yes tries again when that is offered; otherwise a person names an option (a draft pull request), closes
 * or stops. While it revises its open pull request, the plan stays the review's and the one option is to try again.
 */
function stuckView(a: IssueAttempt, q: QuestionRef, before: readonly PlanPart[], approved: boolean): AskedView {
  const options = optionParts(a, q, before);
  const revising = a.attempt.prNumber !== null;
  const plan = revising ? [...before] : options;
  const parts = { fix: [], drop: droppedOf(plan) };
  const reason = STUCK_CAUSES[a.question!.cause as StuckCause] ?? null;
  const stuck = reason === null ? t("The implementation is stuck.") : t("The implementation is stuck ({reason}).", { reason });
  const again = options.find((p) => p.option === STUCK_OPTIONS.tryAgain.key && p.state === "planned");
  if (again) {
    const text = approved ? t("{stuck} Start it again, then merge.", { stuck }) : t("{stuck} Start it again, then come back with the result.", { stuck });
    return { plan, rec: { text, parts, merges: approved, answer: { question: q, option: again.option!, label: again.title }, question: q } };
  }
  const text = options.length && !revising
    ? t("{stuck} Name the option to go with, such as “{n}”, or reply close or stop.", { stuck, n: exampleOf(plan) })
    : t("{stuck} Reply close, or stop and implement it again.", { stuck });
  return { plan, rec: { text, parts, merges: false, question: q } };
}

/** The recommendation and the numbered plan an attempt's open question `q` comes back with. */
export const viewOf = (a: IssueAttempt, q: QuestionRef, before: readonly PlanPart[], approved: boolean): AskedView =>
  (a.attempt.state === "stuck" ? stuckView : askedView)(a, q, before, approved);
