// The one order of work, in every queue: started items of weight 3 and up by weight, then the older workflow; then items nobody started,
// by rank; then started items of weight 2 and below. The SQL form is workScore (src/data/workflow/fragments.ts).

/** Started work of at most this weight comes after unstarted work. */
export const LOW_WEIGHT = 2;
/** Above every rank score; workflow ids stay below one step of the weight. */
export const STARTED_SCORE = 1e15;
export const WEIGHT_STEP = 1e12;
/** The score of an item nobody started, where the rank does not order it; rank scores are not negative. */
export const NO_WORKFLOW_SCORE = 0;

/** The work score of a live workflow (higher first); null without one. */
export const workScore = (w: { id: number; weight: number } | null): number | null =>
  (w ? (w.weight > LOW_WEIGHT ? STARTED_SCORE : -STARTED_SCORE) + w.weight * WEIGHT_STEP - w.id : null);

/** The weight behind a live workflow's work score. */
export const weightOfScore = (score: number): number => Math.ceil((score - (score > NO_WORKFLOW_SCORE ? STARTED_SCORE : -STARTED_SCORE)) / WEIGHT_STEP);

/** Highest score first; an item with no score comes after the ranked ones. */
export const byScore = (a: number | null, b: number | null): number => (b ?? NO_WORKFLOW_SCORE) - (a ?? NO_WORKFLOW_SCORE) || (a === null ? 1 : 0) - (b === null ? 1 : 0);
