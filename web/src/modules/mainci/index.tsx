import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";

const MainCiView = lazyView(() => import("./views"), "MainCiView");

export const mainCiModule: FeatureModule = {
  id: "main-ci",
  permission: "viewer",
  routes: [{ path: "main-ci", view: { id: "main-ci", title: "Main CI", panels: [{ id: "main", title: "Main CI", component: MainCiView, defaultSize: 100 }] } }],
};
