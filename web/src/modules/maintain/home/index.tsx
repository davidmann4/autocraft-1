// Home: one Task Runner line, then what waits for the reader's answer, what they started,
// problems, stuck items and the live board.
import type { FeatureModule } from "../../../registry/types";
import { lazyView } from "../../../registry/lazyView";
import { t } from "../../../../../src/i18n/index.ts";

const HomeView = lazyView(() => import("./views"), "HomeView");

export const maintainHomeModule: FeatureModule = {
  id: "maintain-home",
  permission: "viewer",
  commands: [
    { id: "go-home", keys: "g h", label: t("Go to Home"), group: "Go to" },
    { id: "go-queue", keys: "g q", label: t("Go to work queue"), group: "Go to" },
    { id: "go-stats", keys: "g s", label: t("Go to stats"), group: "Go to" },
  ],
  routes: [{ path: "/", scoped: true, view: { id: "maintain-home", title: t("Home"), phone: HomeView, panels: [{ id: "main", title: t("Home"), component: HomeView, defaultSize: 100 }] } }],
};
