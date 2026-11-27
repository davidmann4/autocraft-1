import { useState } from "react";
import { CpuIcon } from "@phosphor-icons/react";
import { t } from "../../../../../src/i18n/index.ts";
import type { ChatRunner } from "../../../api/types";
import { Button } from "../../atoms/Button";

/**
 * Under the queued work: the Task Runners taken onto the item's work besides its starter's (staff only), and the reader's take or
 * release, which sends the command of that name.
 */
export function RunnerLine({ r, onPress }: { r: ChatRunner; onPress: (word: "take" | "release") => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const press = async (word: "take" | "release") => {
    setBusy(true);
    try {
      await onPress(word);
    } finally {
      setBusy(false);
    }
  };
  const on = r.on.length === 1 ? t("Running on {login}'s Task Runner", { login: r.on[0]! }) : r.on.length > 1 ? t("Running on the Task Runners of {logins}", { logins: r.on.join(", ") }) : null;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      {on && (
        <span className="flex min-w-0 flex-1 items-start gap-2.5">
          <CpuIcon aria-hidden weight="bold" className="mt-[3px] shrink-0 text-ink/60" />
          <span className="min-w-0 text-ink/70 [overflow-wrap:anywhere]">{on}</span>
        </span>
      )}
      {r.action && (
        <Button icon={CpuIcon} loading={busy} onClick={() => void press(r.action!)} className="max-md:h-11">
          {r.action === "take" ? t("Run on my Task Runner") : t("Release my Task Runner")}
        </Button>
      )}
    </li>
  );
}
