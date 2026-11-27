// The Items page: a paged browser over every item of the visible repos, with a qualifier search, views, quick filters
// and a command box for several items at once.
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
    // Older links to a filtered list open the same page.
    { path: "items/filters", scoped: true, view: { id: "maintain-items-filters", title: t("Items"), phone: ItemsView, panels: [{ id: "main", title: t("Items"), component: ItemsView, defaultSize: 100 }] } },
  ],
};
