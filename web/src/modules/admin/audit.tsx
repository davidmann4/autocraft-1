import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";

const AuditView = lazyView(() => import("./auditViews"), "AuditView");

export const auditModule: FeatureModule = {
  id: "audit",
  permission: "staff",
  routes: [{ path: "audit", permission: "staff", view: { id: "audit", title: "Audit", panels: [{ id: "main", title: "Audit", component: AuditView, defaultSize: 100 }] } }],
};
