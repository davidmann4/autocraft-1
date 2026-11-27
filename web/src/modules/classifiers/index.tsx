import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";

const Classifiers = lazyView(() => import("./views"), "Classifiers");

export const classifiersModule: FeatureModule = {
  id: "classifiers",
  permission: "viewer",
  routes: [{ path: "classifiers", view: { id: "classifiers", title: "Classifiers", panels: [{ id: "main", title: "Classifiers", component: Classifiers, defaultSize: 100 }] } }],
};
