import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";

const RatesView = lazyView(() => import("./views"), "RatesView");

export const ratesModule: FeatureModule = {
  id: "rates",
  permission: "viewer",
  routes: [{ path: "rates", view: { id: "rates", title: "Rates", panels: [{ id: "main", title: "Rates", component: RatesView, defaultSize: 100 }] } }],
};
