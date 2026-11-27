// The pipeline switch and the paused stages, as the health list and the Needs page show them: a few reads, not the Pipeline page's full stage state.
import { PIPELINE_DRAIN } from "../../core/rules.ts";
import { DEFAULT_PER_DAY, KEY_AT, KEY_BY, KEY_ENABLED, LIMIT_STEPS } from "../../runner/autopilot.ts";
import { loadSteps } from "../../runner/steps.ts";
import type { Db } from "../../db/index.ts";
import { loadStageLimits, settings } from "../../data/control/index.ts";

export type PipelineSwitch = { enabled: boolean; draining: boolean; changedBy: string | null; changedAt: string | null };

export async function pipelineSwitch(db: Db): Promise<PipelineSwitch> {
  const v = await settings(db, [KEY_ENABLED, KEY_BY, KEY_AT]);
  return { enabled: v.get(KEY_ENABLED) === "1", draining: v.get(KEY_ENABLED) === PIPELINE_DRAIN, changedBy: v.get(KEY_BY) ?? null, changedAt: v.get(KEY_AT) ?? null };
}

/** Stages whose daily limit is 0, in stage-limit order. A breaker trips one repo of a stage, so it is listed on its own beside the limit. */
export async function zeroLimits(db: Db): Promise<{ step: string; title: string }[]> {
  const steps = await loadSteps();
  const limits = await loadStageLimits(db, DEFAULT_PER_DAY);
  return LIMIT_STEPS
    .filter((step) => (limits.get(step)?.perDay ?? null) === 0)
    .map((step) => ({ step, title: steps.get(step)?.title ?? step }));
}
