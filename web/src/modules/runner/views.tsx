import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "../../api/client";
import type { ViewProps } from "../../registry/types";
import { Badge } from "../../ui/atoms/Badge";
import { Button } from "../../ui/atoms/Button";
import { Page } from "../../ui/organisms/Page";
import { LinkDiscordDialog } from "../../shell/LinkDiscord";
import { UnlinkDiscordDialog } from "../../shell/UnlinkDiscord";
import { t } from "../../../../src/i18n/index.ts";
import { Connector } from "../connect/views";
import { Fold } from "../connect/Fold";
import { MySettings } from "../connect/MySettings";
import { Runners } from "../connect/Runners";
import { RunnerGuide } from "../connect/Setup";

const pct = (w: { usedPercent: number } | null | undefined) => (w ? `${Math.round(w.usedPercent)}%` : "–");

/** The user's runners, each with its state and the plan quota it has used. */
function Status() {
  const { data } = useQuery("runners", (a) => a.runners.list());
  if (!data?.runners.length) return null;
  return (
    <section aria-label={t("Status")} className="flex flex-col gap-3">
      {data.runners.map((r) => (
        <div key={r.tokenId} className="flex flex-col gap-1">
          <p className="flex flex-wrap items-center gap-2 text-md">
            <span className="font-semibold">{r.label ?? `Runner ${r.tokenId}`}</span>
            <Badge tone={r.fresh ? "ok" : "bad"}>{r.fresh ? t("Online") : t("Offline")}</Badge>
          </p>
          {r.usage && (
            <p className="text-sm text-ink/80">
              {t("Quota used")}: {t("5-hour")} {pct(r.usage.fiveHour)} · {t("weekly")} {pct(r.usage.weekly)}
            </p>
          )}
        </div>
      ))}
    </section>
  );
}

function Discord() {
  const link = useQuery("discord-account", (a) => a.discord.account());
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  if (!link.data?.configured && !link.data?.linked) return null;
  return (
    <section aria-label="Discord" className="flex flex-col gap-2 border-t border-line pt-4">
      <h2 className="text-md font-semibold">Discord</h2>
      {link.data?.linked ? (
        <div className="flex flex-wrap items-center gap-3 text-md">
          <span>{t("Linked")}</span>
          <Button className="h-11" onClick={() => setUnlinking(true)}>{t("Unlink")}</Button>
        </div>
      ) : (
        <Button variant="primary" className="h-11 w-fit" onClick={() => setLinking(true)}>{t("Link Discord")}</Button>
      )}
      <LinkDiscordDialog open={linking} linked={!!link.data?.linked} onClose={() => setLinking(false)} />
      <UnlinkDiscordDialog open={unlinking} onClose={() => setUnlinking(false)} onDone={() => link.refetch()} />
    </section>
  );
}

export function RunnerView({ user }: ViewProps) {
  const [sp] = useSearchParams();
  const local = user.inference === "user-local";
  const runners = useQuery("runners", (a) => a.runners.list(), { enabled: local });
  if (local && !runners.data && !runners.error) return <Page title={t("Runner")}><></></Page>;
  // No Task Runner yet: the setup steps and agent tokens; a login waiting for approval (`?runner=CODE`) still shows its card.
  const none = local && runners.data?.runners.length === 0 && !sp.get("runner");
  return (
    <Page title={t("Runner")}>
      <div className="mt-4 flex flex-col gap-4">
        {none && <RunnerGuide />}
        {local && !none && <Status />}
        {local && !none && (
          <Fold title={t("All runners and approval")} open={!!sp.get("runner")}>
            <Runners />
          </Fold>
        )}
      </div>
      {local && !none && <MySettings runner />}
      {local && !none && <Discord />}
      <Connector user={user} agent />
    </Page>
  );
}
