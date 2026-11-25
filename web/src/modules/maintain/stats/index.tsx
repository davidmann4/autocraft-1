// The new dashboard's Stats (ui_v2): progress and merges, Main CI, Nightly and Cost on the page; Activity, Classifiers,
// Rates and agents, and Downloads in folds. Every part hosts the existing view.
import type { FeatureModule } from "../../../registry/types";
import { lazyView } from "../../../registry/lazyView";
import { t } from "../../../../../src/i18n/index.ts";

const StatsView = lazyView(() => import("./views"), "StatsView");

export const maintainStatsModule: FeatureModule = {
  id: "maintain-stats",
  permission: "viewer",
  routes: [{ path: "stats", view: { id: "maintain-stats", title: t("Stats"), panels: [{ id: "main", title: t("Stats"), component: StatsView, defaultSize: 100 }] } }],
};
