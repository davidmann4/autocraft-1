import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";

const Cost = lazyView(() => import("./views"), "Cost");

export const costModule: FeatureModule = {
  id: "cost",
  permission: "viewer",
  routes: [{ path: "cost", view: { id: "cost", title: "Cost", panels: [{ id: "main", title: "Cost", component: Cost, defaultSize: 100 }] } }],
};
