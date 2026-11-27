import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";

const ContributorsView = lazyView(() => import("./contributorsViews"), "ContributorsView");

export const contributorsModule: FeatureModule = {
  id: "contributors",
  permission: "viewer",
  routes: [{ path: "contributors", view: { id: "contributors", title: "Contributors", panels: [{ id: "main", title: "Contributors", component: ContributorsView, defaultSize: 100 }] } }],
};
