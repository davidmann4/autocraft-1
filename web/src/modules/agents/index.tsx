import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";

const AgentsView = lazyView(() => import("./views"), "AgentsView");
const DetailPanel = lazyView(() => import("./views"), "DetailPanel");
const PhoneAgents = lazyView(() => import("./views"), "PhoneAgents");
const ModelQueueView = lazyView(() => import("./queue"), "ModelQueueView");
const TranscriptPage = lazyView(() => import("./transcript"), "TranscriptPage");

export const agentsModule: FeatureModule = {
  id: "agents",
  permission: "viewer",
  routes: [
    {
      path: "agents/:id?",
      view: {
        id: "agents",
        title: "Agents",
        phone: PhoneAgents,
        panels: [
          { id: "main", title: "Agents", component: AgentsView, defaultSize: 62, minSize: 40 },
          { id: "run", title: "Run", component: DetailPanel, defaultSize: 38, minSize: 24, collapsible: true },
        ],
      },
    },
    {
      path: "agents/:id/transcripts/:tid",
      permission: "staff",
      view: { id: "agent-transcript", title: "Transcript", panels: [{ id: "main", title: "Transcript", component: TranscriptPage, defaultSize: 100 }] },
    },
    { path: "model-queue", view: { id: "model-queue", title: "Model call queue", panels: [{ id: "main", title: "Model call queue", component: ModelQueueView, defaultSize: 100 }] } },
  ],
};
