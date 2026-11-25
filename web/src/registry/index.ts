// The lists of feature modules: the classic dashboard's, and the new dashboard's for users with `ui_v2` on. Adding a feature
// means adding its module here; the shell builds routes, panels and shortcut help from these declarations.
import type { FeatureModule } from "./types";
import { setListPages } from "../api/scope";
import { needsModule } from "../modules/needs";
import { flowModule } from "../modules/flow";
import { nowModule } from "../modules/now";
import { itemModule } from "../modules/item";
import { progressModule } from "../modules/progress";
import { itemsModule } from "../modules/items";
import { classifiersModule } from "../modules/classifiers";
import { costModule } from "../modules/cost";
import { downloadsModule } from "../modules/downloads";
import { adminHubModule } from "../modules/admin/v2";
import { accessModule, auditModule, contributorsModule, githubAppModule, discordModule, reposModule } from "../modules/admin";
import { aboutModule } from "../modules/about";
import { connectModule } from "../modules/connect";
import { pipelineModule } from "../modules/pipeline";
import { promptsModule } from "../modules/prompts";
import { accountsModule } from "../modules/accounts";
import { inferenceModule } from "../modules/inference";
import { agentsModule } from "../modules/agents";
import { envsModule } from "../modules/envs";
import { workspacesModule } from "../modules/workspaces";
import { ratesModule } from "../modules/rates";
import { nextModule } from "../modules/next";
import { similarModule } from "../modules/similar";
import { mainCiModule } from "../modules/mainci";
import { nightlyModule } from "../modules/nightly";
import { stuckModule } from "../modules/stuck";
import { activityModule } from "../modules/activity";
import { batchModule } from "../modules/batch";
import { securityModule } from "../modules/security";
import { homeModule } from "../modules/home";
import { hubModule } from "../modules/hub";
import { maintainHomeModule } from "../modules/maintain/home";
import { helpModule } from "../modules/help";
import { maintainQueueModule } from "../modules/maintain/queue";
import { maintainStatsModule } from "../modules/maintain/stats";
import { runnerModule } from "../modules/runner";
import { maintainItemsModule } from "../modules/maintain/items";
import { maintainItemModule } from "../modules/maintain/item";
import { referenceModule } from "../modules/reference";

export const classicModules: FeatureModule[] = [homeModule, hubModule, nowModule, flowModule, needsModule, nextModule, agentsModule, envsModule, workspacesModule, ratesModule, itemModule, progressModule, itemsModule, activityModule, contributorsModule, classifiersModule, costModule, downloadsModule, reposModule, accessModule, githubAppModule, discordModule, auditModule, aboutModule, connectModule, pipelineModule, promptsModule, similarModule, accountsModule, inferenceModule, mainCiModule, nightlyModule, stuckModule, batchModule, securityModule];

/** Classic modules the new dashboard's own pages replace. */
const replacedInV2: FeatureModule[] = [homeModule, itemsModule, itemModule, promptsModule, githubAppModule, discordModule];
/** Classic routes the new dashboard replaces inside modules that stay. */
const replacedRoutes = new Map<FeatureModule, string[]>([[envsModule, ["envs/:id?"]], [reposModule, ["repos", "repos/:name"]]]);
const without = (m: FeatureModule): FeatureModule => {
  const paths = replacedRoutes.get(m);
  return paths ? { ...m, routes: m.routes.filter((r) => !paths.includes(r.path)) } : m;
};

/** The new dashboard: its own pages; the classic views serve the pages it has not replaced yet. */
export const v2Modules: FeatureModule[] = [
  maintainHomeModule,
  maintainQueueModule,
  maintainStatsModule,
  helpModule,
  runnerModule,
  maintainItemsModule,
  maintainItemModule,
  referenceModule,
  adminHubModule,
  ...classicModules.filter((m) => !replacedInV2.includes(m)).map(without),
];

/** Every module of either dashboard, for preloading code. */
export const allModules: FeatureModule[] = [...new Set([...classicModules, ...v2Modules])];

/** The signed-in user's list; selectModules sets it before the app renders. */
export let modules: FeatureModule[] = classicModules;

/** Picks the module list by the user's `ui_v2` switch. */
export function selectModules(uiV2: boolean): FeatureModule[] {
  modules = uiV2 ? v2Modules : classicModules;
  setListPages(modules.flatMap((m) => m.routes.filter((r) => r.scoped).map((r) => r.path)));
  return modules;
}

selectModules(false);
