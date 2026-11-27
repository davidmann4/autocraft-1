import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";

const StuckView = lazyView(() => import("./views"), "StuckView");

export const stuckModule: FeatureModule = {
  id: "stuck",
  permission: "staff",
  routes: [{ path: "stuck", view: { id: "stuck", title: "Stuck items", panels: [{ id: "stuck", title: "Stuck items", component: StuckView, defaultSize: 100 }] } }],
};
