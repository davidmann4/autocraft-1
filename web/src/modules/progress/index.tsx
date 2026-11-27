import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";

const Overview = lazyView(() => import("./views"), "Overview");

export const progressModule: FeatureModule = {
  id: "progress",
  permission: "viewer",
  commands: [{ id: "go-progress", keys: "g p", label: "Go to progress", group: "Go to" }],
  routes: [{ path: "progress", view: { id: "progress", title: "Progress", panels: [{ id: "overview", title: "Overview", component: Overview, defaultSize: 100 }] } }],
};
