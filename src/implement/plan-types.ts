// The input of the implement.plan call and its limits. No Node imports: the prompt registry (and so the web mockup) imports it.
import type { QuestionAudience } from "./types.ts";

/** Characters of the issue body, of each comment and of each guidance text the plan call sees. */
export const PLAN_BODY_CHARS = 20_000;
export const PLAN_COMMENT_CHARS = 4_000;
export const PLAN_COMMENTS_MAX = 60;
export const PLAN_GUIDANCE_CHARS = 2_000;
export const PLAN_GUIDANCE_MAX = 20;
/** Limits of the reply: the summary, one question's text, questions per reply and options per question. */
export const PLAN_SUMMARY_CHARS = 400;
export const PLAN_QUESTION_CHARS = 800;
export const PLAN_QUESTIONS_MAX = 3;
export const PLAN_OPTIONS_MAX = 3;
export const PLAN_ACCEPTANCE_MAX = 12;
/** Limits of the plan text and of each acceptance criterion, risk and verification item, and items per list: the plan goes into the PR body (65,536 characters at most). */
export const PLAN_TEXT_CHARS = 16_000;
export const PLAN_ITEM_CHARS = 600;
export const PLAN_ITEMS_MAX = 12;
/** Maintainer workflow: numbered parts of a ready plan, files each part may name, and the recommendation sentence of a plan that asks. */
export const PLAN_PARTS_MAX = 8;
export const PLAN_PART_FILES_MAX = 20;
export const PLAN_PART_TITLE_CHARS = 80;
export const PLAN_RECOMMENDATION_CHARS = 300;
/** Question rounds an attempt may ask before a maintainer decides whether to go on with stated assumptions. */
export const QUESTION_ROUNDS_MAX = 3;

/** The model call's limits: one call of up to 45 minutes and 200 turns. */
export const PLAN_TIMEOUT_SEC = 45 * 60;
export const PLAN_MAX_TURNS = 200;

export type PlanIssue = {
  number: number;
  title: string;
  body: string;
  author: string | null;
  labels: string[];
  comments: { author: string | null; at: string; body: string }[];
};

/** A person's word on the issue: an operator's or a write-maintainer's message in its thread, or an answer to one of our questions. */
/** `try-again`: the note a person who settles on the repo gave with Try again on the earlier attempt's stuck blocker. */
export type PlanGuidance = { from: "operator" | "maintainer" | "try-again"; login: string; at: string; text: string };

/** A question an earlier plan round asked, with its answer when a person gave one. */
export type PlanAsked = { audience: QuestionAudience; text: string; at: string; answer: string | null };

export type PlanInput = {
  ref: string;
  repo: string;
  sha: string;
  issue: PlanIssue;
  guidance: PlanGuidance[];
  asked: PlanAsked[];
  /** A maintainer chose to go on with the plan's stated assumptions: the reply must be ready. */
  assume: boolean;
  /** The issue's repo runs the maintainer workflow: the reply adds numbered parts and a recommendation. Absent elsewhere. */
  workflow?: boolean;
};

export const SAMPLE_PLAN: PlanInput[] = [{
  ref: "app#412", repo: "app", sha: "0123456789abcdef0123456789abcdef01234567",
  issue: {
    number: 412, title: "Export dialog forgets the last folder", author: "someone", labels: ["bug"],
    body: "Steps: open File > Export, pick a folder, export, open the dialog again. Expected: the folder I picked. Actual: the home folder.",
    comments: [{ author: "other", at: "2026-11-20T10:00:00Z", body: "Same here on Linux." }],
  },
  guidance: [{ from: "maintainer", login: "maintainer-login", at: "2026-11-21T09:00:00Z", text: "Store it per document, not globally." }],
  asked: [],
  assume: false,
}];
