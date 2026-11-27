// Work queue: what runs, what waits and why, the merge queue with its batches, the model call queue
// and what merged recently.
import type { FeatureModule } from "../../../registry/types";
import { lazyView } from "../../../registry/lazyView";
import { t } from "../../../../../src/i18n/index.ts";

const QueueView = lazyView(() => import("./views"), "QueueView");

export const maintainQueueModule: FeatureModule = {
  id: "maintain-queue",
  permission: "viewer",
  routes: [{ path: "queue", scoped: true, view: { id: "maintain-queue", title: t("Work queue"), phone: QueueView, panels: [{ id: "main", title: t("Work queue"), component: QueueView, defaultSize: 100 }] } }],
};
