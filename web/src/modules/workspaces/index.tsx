import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";
import { CubeIcon } from "@phosphor-icons/react";

const WorkspacesView = lazyView(() => import("./views"), "WorkspacesView");

export const workspacesModule: FeatureModule = {
  id: "workspaces",
  permission: "viewer",
  nav: { label: "Workspaces", icon: CubeIcon, to: "/workspaces" },
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
