import { useState } from "react";
import { HourglassIcon } from "@phosphor-icons/react";
import { t } from "../../../../src/i18n/index.ts";
import { Button } from "../atoms/Button";
import { ErrorLine } from "../atoms/ErrorLine";

/** A press that waits for room under the daily GitHub write limit. The person who pressed it, and operators, dismiss it. Props only: the caller runs the call. */
export function QueuedPress({ by, reason, viewer, onDismiss }: { by: string; reason: string; viewer: { login: string; operator: boolean }; onDismiss: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dismiss = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onDismiss();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2 space-y-2 text-sm">
      <p className="flex items-start gap-1.5 font-medium text-ink/80">
        <HourglassIcon aria-hidden className="mt-1 shrink-0" />
        <span className="min-w-0">{t("Pressed by {login}, waiting: {reason}", { login: by, reason })}</span>
      </p>
      {(viewer.operator || by.toLowerCase() === viewer.login.toLowerCase()) && (
        <Button size="sm" variant="secondary" className="max-md:h-11" loading={busy} onClick={() => void dismiss()}>
          {t("Dismiss")}
        </Button>
      )}
      <ErrorLine error={error} className="text-xs" />
    </div>
  );
}
