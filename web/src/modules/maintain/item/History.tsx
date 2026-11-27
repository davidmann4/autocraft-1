// The item's Events tab, oldest first: what people told AutoCraft (workflow events) beside every trace event: GitHub activity,
// model calls, tool runs, jobs, plan changes, reviews, questions and writes. Each trace row opens to its detail (TraceEventBody);
// `focus` opens one row and scrolls to it.
import { useEffect, useMemo, useState } from "react";
import { ChatTextIcon } from "@phosphor-icons/react";
import { t } from "../../../../../src/i18n/index.ts";
import { useQuery } from "../../../api/client";
import type { ItemKind, MaintainEvent } from "../../../api/types";
import { historyRows } from "../../../lib/history";
import { TRACE_KIND, eventCost } from "../../../lib/trace";
import { ErrorLine } from "../../../ui/atoms/ErrorLine";
import { TimeAgo } from "../../../ui/atoms/TimeAgo";
import { TimelineEvent } from "../../../ui/molecules/TimelineEvent";
import { TraceEventBody } from "../../activity/TraceEventBody";

const VIA: Record<MaintainEvent["via"], string> = { github: "GitHub", discord: "Discord", agent: "agent", dashboard: "AutoCraft", cli: "CLI" };

function Said({ e }: { e: MaintainEvent }) {
  return (
    <li className="flex items-start gap-2.5 border-b border-line px-3 py-2 last:border-0 max-md:min-h-11">
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-accent/60 bg-panel text-accent-ink">
        <ChatTextIcon aria-hidden className="text-[11px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block break-words text-sm leading-5 [overflow-wrap:anywhere]">{e.line ?? e.kind}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink/70">
          <span className="font-medium text-ink">{e.login}</span>
          <span>{t("via {surface}", { surface: VIA[e.via] })}</span>
          <TimeAgo iso={e.at} className="num" />
        </span>
      </span>
    </li>
  );
}

/** `focusKey` changes on every request to show `focus`, so asking for the same event again scrolls to it again. */
export function History({ repo, number, kind, said, focus, focusKey }: { repo: string; number: number; kind: ItemKind; said: MaintainEvent[]; focus?: string | null; focusKey?: number }) {
  const [open, setOpen] = useState<Set<string>>(new Set(focus ? [focus] : []));
  const { data, error } = useQuery(`item-trace:v2:${repo}#${number}`, async (a) => {
    const r = await a.itemTrace(repo, number, { limit: 300 });
    if ("unchanged" in r) throw new Error("unexpected empty answer");
    return r;
  });
  const rows = useMemo(() => historyRows(said, data?.events ?? []), [data, said]);
  const loaded = !!data;
  // Live refetches leave the reader where they are: only a new request (or the first load) scrolls.
  useEffect(() => {
    if (!focus || !loaded) return;
    setOpen((s) => new Set(s).add(focus));
    const row = document.getElementById(`event-${focus}`);
    row?.scrollIntoView({ block: "center" });
    row?.querySelector("button")?.focus({ preventScroll: true });
  }, [focus, focusKey, loaded]);
  const toggle = (id: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  return (
    <div className="flex flex-col gap-2">
      <ErrorLine error={error?.message} />
      {!data && !error && <p className="text-sm text-ink/70" role="status">{t("Loading…")}</p>}
      {data && rows.length === 0 && <p className="text-sm text-ink/70">{t("Nothing yet.")}</p>}
      {rows.length > 0 && (
        <ol aria-label={t("Events, oldest first")} className="rounded-lg border border-line bg-panel">
          {rows.map((r) =>
            r.t === "said" ? (
              <Said key={`w${r.e.id}`} e={r.e} />
            ) : (
              <TimelineEvent
                key={r.e.id}
                id={r.e.id}
                Icon={TRACE_KIND[r.e.kind].Icon}
                iconLabel={TRACE_KIND[r.e.kind].label}
                iconTone={r.e.actor.type === "person" ? "person" : "ours"}
                at={r.e.at}
                actor={r.e.actor.name}
                actorTone={r.e.actor.type === "person" ? "person" : "ours"}
                cost={eventCost(r.e)}
                summary={r.e.summary}
                open={open.has(r.e.id)}
                onToggle={() => toggle(r.e.id)}
              >
                <TraceEventBody event={r.e} item={{ repo, number, kind }} />
              </TimelineEvent>
            ),
          )}
        </ol>
      )}
    </div>
  );
}
