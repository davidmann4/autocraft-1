// The new dashboard's Items page (ui_v2): what needs an answer, what was started, what AutoCraft works by itself and the rest,
// with filters, search and a command box for several items at once.
import type { FeatureModule } from "../../../registry/types";
import { lazyView } from "../../../registry/lazyView";
import { t } from "../../../../../src/i18n/index.ts";

const ItemsView = lazyView(() => import("./views"), "ItemsView");

export const maintainItemsModule: FeatureModule = {
  id: "maintain-items",
  permission: "viewer",
  commands: [{ id: "go-items", keys: "g i", label: t("Go to items"), group: "Go to" }],
  routes: [
    { path: "items", scoped: true, view: { id: "maintain-items", title: t("Items"), phone: ItemsView, panels: [{ id: "main", title: t("Items"), component: ItemsView, defaultSize: 100 }] } },
    // Links to the classic browser's filter view open the same page.
    { path: "items/filters", scoped: true, view: { id: "maintain-items-filters", title: t("Items"), phone: ItemsView, panels: [{ id: "main", title: t("Items"), component: ItemsView, defaultSize: 100 }] } },
  ],
};
