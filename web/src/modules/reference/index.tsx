// The new dashboard's reference pages: Prompts, Environments, Repos and Scans.
import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";
import { t } from "../../../../src/i18n/index.ts";

const PromptsView = lazyView(() => import("./views"), "PromptsView");
const EnvironmentsView = lazyView(() => import("./views"), "EnvironmentsView");
const ScansView = lazyView(() => import("./views"), "ScansView");
const ReposView = lazyView(() => import("./repos"), "ReposView");

const page = (id: string, title: string, component: typeof PromptsView) => ({ id, title, panels: [{ id: "main", title, component, defaultSize: 100 }] });

export const referenceModule: FeatureModule = {
  id: "reference",
  permission: "viewer",
  commands: [],
  routes: [
    { path: "prompts", view: page("prompts", t("Prompts"), PromptsView) },
    { path: "envs/:id?", view: page("envs", t("Environments"), EnvironmentsView) },
    { path: "repos/:name?", view: page("repos", t("Repos"), ReposView) },
    { path: "scans", permission: "staff", view: page("scans", t("Scans"), ScansView) },
  ],
};
