// The list of feature modules. Adding a feature means adding its module here; the shell builds routes, panels and shortcut help
// from these declarations.
import type { FeatureModule } from "./types";
import { setListPages } from "../api/scope";
import { maintainHomeModule } from "../modules/maintain/home";
import { maintainQueueModule } from "../modules/maintain/queue";
import { maintainStatsModule } from "../modules/maintain/stats";
import { maintainItemsModule } from "../modules/maintain/items";
import { maintainItemModule } from "../modules/maintain/item";
import { helpModule } from "../modules/help";
import { runnerModule } from "../modules/runner";
import { referenceModule } from "../modules/reference";
import { adminHubModule } from "../modules/admin/hub";
import { accessModule, auditModule, contributorsModule } from "../modules/admin";
import { nextModule } from "../modules/next";
import { agentsModule } from "../modules/agents";
import { workspacesModule } from "../modules/workspaces";
import { ratesModule } from "../modules/rates";
import { progressModule } from "../modules/progress";
import { activityModule } from "../modules/activity";
import { classifiersModule } from "../modules/classifiers";
import { costModule } from "../modules/cost";
import { downloadsModule } from "../modules/downloads";
import { connectModule } from "../modules/connect";
import { pipelineModule } from "../modules/pipeline";
import { inferenceModule } from "../modules/inference";
import { mainCiModule } from "../modules/mainci";
import { nightlyModule } from "../modules/nightly";
import { stuckModule } from "../modules/stuck";
import { batchModule } from "../modules/batch";
import { securityModule } from "../modules/security";
import { similarModule } from "../modules/similar";

export const modules: FeatureModule[] = [
  maintainHomeModule,
  maintainQueueModule,
  maintainStatsModule,
  helpModule,
  runnerModule,
  maintainItemsModule,
  maintainItemModule,
  referenceModule,
  adminHubModule,
  nextModule,
  agentsModule,
  workspacesModule,
  ratesModule,
  progressModule,
  activityModule,
  contributorsModule,
  classifiersModule,
  costModule,
  downloadsModule,
  accessModule,
  auditModule,
  connectModule,
  pipelineModule,
  inferenceModule,
  mainCiModule,
  nightlyModule,
  stuckModule,
  batchModule,
  securityModule,
  similarModule,
];

setListPages(modules.flatMap((m) => m.routes.filter((r) => r.scoped).map((r) => r.path)));
