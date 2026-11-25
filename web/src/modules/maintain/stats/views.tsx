// Stats: what the pipeline got done, how main and the nightly checks stand, what it cost; the rest in folds.
// Maintainers and viewers see it as well as operators. Hosted views drop their own frame and heading (Embedded).
import type { ReactNode } from "react";
import { Headline } from "./Headline";
import { t } from "../../../../../src/i18n/index.ts";
import { Embedded } from "../../../ui/organisms/Page";
import { Fold } from "../../connect/Fold";
import { Overview } from "../../progress/views";
import { MainCiView } from "../../mainci/views";
import { NightlyView } from "../../nightly/views";
import { Cost } from "../../cost/views";
import { ActivityView } from "../../activity/views";
import { Classifiers } from "../../classifiers/views";
import { RatesView } from "../../rates/views";
import { AgentsView } from "../../agents/views";
import { Downloads } from "../../downloads/views";
import type { ViewProps } from "../../../registry/types";

function Details({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-3 py-1">
      <Fold title={<span className="text-md font-semibold text-ink">{title}</span>}>
        <div className="pb-3">{children}</div>
      </Fold>
    </div>
  );
}

export function StatsView(props: ViewProps) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1180px] flex-col gap-6 px-4 pb-12 pt-5 md:px-6">
        <Headline />
        <Embedded>
          <div className="flex flex-col gap-2">
            <Details title={t("Merged and closed")}>
              <Overview {...props} />
            </Details>
            <Details title={t("Main CI")}>
              <MainCiView {...props} />
            </Details>
            <Details title={t("Nightly")}>
              <NightlyView />
            </Details>
            <Details title={t("Cost")}>
              <Cost {...props} />
            </Details>
            <Details title={t("Model calls")}>
              <div className="flex flex-col gap-6">
                <ActivityView />
                <RatesView />
                <AgentsView {...props} />
              </div>
            </Details>
            <Details title={t("Classifiers")}>
              <Classifiers {...props} />
            </Details>
            <Details title={t("Downloads")}>
              <Downloads {...props} />
            </Details>
          </div>
        </Embedded>
      </div>
    </div>
  );
}
