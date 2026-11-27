// The Pipeline page's overview: the newest job of each step, the stage states, the queue counts, the recent syncs and two settings in one wave.
import type { Db } from "../../db/index.ts";
import { settings } from "../control/settings.ts";
import { countJobs, loadLastJobPerStep, loadStageStates } from "../jobs/views.ts";
import type { HiddenRepos, JobRow, JobState, StageState } from "../jobs/types.ts";
import { loadSyncRuns } from "../mirror/sync.ts";
import type { SyncRunRow } from "../mirror/types.ts";

export type PipelineOverviewFacts = {
  lastJobs: Map<string, JobRow>; stageStates: Map<number, StageState>; counts: Map<JobState, number>; syncRuns: SyncRunRow[]; settings: Map<string, string>;
};

/** Four loaders and one settings read in one `together` wave. */
export async function loadPipelineOverview(db: Db, o: { steps: string[]; stages: { n: number; steps: string[] }[]; hidden: HiddenRepos; syncRuns: number; settingKeys: string[] }): Promise<PipelineOverviewFacts> {
  const [lastJobs, stageStates, counts, syncRuns, values] = await db.together(() => Promise.all([
    loadLastJobPerStep(db, o.steps, o.hidden),
    loadStageStates(db, o.stages),
    countJobs(db, ["queued", "running"], o.hidden),
    loadSyncRuns(db, o.syncRuns),
    settings(db, o.settingKeys),
  ]));
  return { lastJobs, stageStates, counts, syncRuns, settings: values };
}
