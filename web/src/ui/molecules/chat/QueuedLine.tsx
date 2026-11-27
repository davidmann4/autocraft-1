import { HourglassMediumIcon } from "@phosphor-icons/react";
import { t } from "../../../../../src/i18n/index.ts";
import type { ChatQueued } from "../../../api/types";
import { TimeAgo } from "../../atoms/TimeAgo";

/** Work about the item that is queued, at the end of the conversation, with the line that says what holds it back. */
export function QueuedLine({ q }: { q: ChatQueued }) {
  return (
    <li className="flex items-start gap-2.5 text-sm">
      <HourglassMediumIcon aria-hidden weight="bold" className="mt-[3px] shrink-0 text-ink/60" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{q.title}</span>
        <span className="text-ink/70">
          {" · "}
          {t("queued")} <TimeAgo iso={q.since} />
        </span>
        {q.why && <span className="block text-ink/70 [overflow-wrap:anywhere]">{q.why}</span>}
      </span>
    </li>
  );
}
