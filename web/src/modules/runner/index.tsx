// The Runner page of the new dashboard (ui_v2): the user's Task Runners and settings, and the agent access tokens. Built from the
// classic Connect module's parts.
import { CpuIcon } from "@phosphor-icons/react";
import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";
import { t } from "../../../../src/i18n/index.ts";

const RunnerView = lazyView(() => import("./views"), "RunnerView");

export const runnerModule: FeatureModule = {
  id: "runner",
  permission: "staff",
  nav: { label: "Runner", icon: CpuIcon, to: "/runner" },
  commands: [],
  routes: [{ path: "runner", view: { id: "runner", title: t("Runner"), phone: RunnerView, panels: [{ id: "main", title: t("Runner"), component: RunnerView, defaultSize: 100 }] } }],
};
