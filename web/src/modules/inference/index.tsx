import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";

const InferenceView = lazyView(() => import("./views"), "InferenceView");

export const inferenceModule: FeatureModule = {
  id: "inference",
  permission: "operator",
  routes: [{ path: "inference", permission: "operator", view: { id: "inference", title: "Inference", panels: [{ id: "main", title: "Inference", component: InferenceView, defaultSize: 100 }] } }],
};
