// The new dashboard's item page (ui_v2): status, steps, numbered parts and the command box beside the GitHub side.
import type { FeatureModule } from "../../../registry/types";
import { lazyView } from "../../../registry/lazyView";
import { t } from "../../../../../src/i18n/index.ts";

const ItemView = lazyView(() => import("./views"), "ItemView");

export const maintainItemModule: FeatureModule = {
  id: "maintain-item",
  permission: "viewer",
  routes: [{ path: "items/:repo/:number", view: { id: "maintain-item", title: t("Item"), phone: ItemView, panels: [{ id: "main", title: t("Item"), component: ItemView, defaultSize: 100 }] } }],
};
