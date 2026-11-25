// The user menu's switch for the new dashboard (the user's `ui_v2` setting). Switching reloads the app at Home, since the
// two dashboards have different pages.
import { useState } from "react";
import { DropdownMenu } from "radix-ui";
import { CheckIcon, SquaresFourIcon } from "@phosphor-icons/react";
import { t } from "../../../src/i18n/index.ts";
import { useApi } from "../api/client";
import { useUser } from "./UserContext";

export function UiV2Item({ className }: { className: string }) {
  const user = useUser();
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const flip = (on: boolean) => {
    setBusy(true);
    api.me.settings.put({ uiV2: on }).then(
      () => window.location.assign("/"),
      () => setBusy(false),
    );
  };
  return (
    <DropdownMenu.CheckboxItem checked={user.uiV2} disabled={busy} onCheckedChange={flip} className={className}>
      <SquaresFourIcon aria-hidden className="text-ink/55" />
      <span className="flex-1">{t("New dashboard")}</span>
      <DropdownMenu.ItemIndicator>
        <CheckIcon aria-hidden className="text-accent-ink" />
      </DropdownMenu.ItemIndicator>
    </DropdownMenu.CheckboxItem>
  );
}
