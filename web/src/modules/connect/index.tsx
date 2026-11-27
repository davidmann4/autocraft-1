import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";

const ConnectView = lazyView(() => import("./views"), "ConnectView");

/** The MCP Connector and Task Runners. Opened by a device-login link, not from the rail. */
export const connectModule: FeatureModule = {
  id: "connect",
  permission: "viewer",
  routes: [{ path: "connect/:tab?", view: { id: "connect", title: "Connect", panels: [{ id: "main", title: "Connect", component: ConnectView, defaultSize: 100 }] } }],
};
