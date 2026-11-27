import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";

const AccessView = lazyView(() => import("./accessViews"), "AccessView");

export const accessModule: FeatureModule = {
  id: "access",
  permission: "operator",
  routes: [{ path: "access", permission: "operator", view: { id: "access", title: "Access", panels: [{ id: "main", title: "Access", component: AccessView, defaultSize: 100 }] } }],
};
