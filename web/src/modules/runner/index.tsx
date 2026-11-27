// The Runner page: the user's Task Runners and settings, and the agent access tokens, built from the Connect module's parts.
import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";
import { t } from "../../../../src/i18n/index.ts";

const RunnerView = lazyView(() => import("./views"), "RunnerView");

export const runnerModule: FeatureModule = {
  id: "runner",
  permission: "staff",
  routes: [{ path: "runner", view: { id: "runner", title: t("Runner"), phone: RunnerView, panels: [{ id: "main", title: t("Runner"), component: RunnerView, defaultSize: 100 }] } }],
};
