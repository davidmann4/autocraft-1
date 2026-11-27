import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";

const WorkspacesView = lazyView(() => import("./views"), "WorkspacesView");

export const workspacesModule: FeatureModule = {
  id: "workspaces",
  permission: "viewer",
  routes: [
    {
      path: "workspaces/:id?",
      view: {
        id: "workspaces",
        title: "Workspaces",
        panels: [{ id: "main", title: "Workspaces", component: WorkspacesView, defaultSize: 100 }],
      },
    },
  ],
};
