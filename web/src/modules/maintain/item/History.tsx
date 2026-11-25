// The item's history, oldest first: what people told AutoCraft (workflow events) beside the trace. By default the trace shows
// people, reviews, questions and GitHub writes; "Every step" adds each model call, tool run, job and plan change. Each trace row
// opens to its detail (TraceEventBody).
import { useMemo, useState } from "react";
import { ChatTextIcon } from "@phosphor-icons/react";
import { t } from "../../../../../src/i18n/index.ts";
import { useQuery } from "../../../api/client";
import type { ItemKind, MaintainEvent, TraceEvent, TraceKind } from "../../../api/types";
import { TRACE_KIND, eventCost } from "../../../lib/trace";
import { ErrorLine } from "../../../ui/atoms/ErrorLine";
import { TimeAgo } from "../../../ui/atoms/TimeAgo";
import { Segmented } from "../../../ui/molecules/Segmented";
import { TimelineEvent } from "../../../ui/molecules/TimelineEvent";
import { TraceEventBody } from "../../item/TraceEventBody";

const MAIN: ReadonlySet<TraceKind> = new Set(["github", "review", "decision", "write", "conversation"]);
const VIA: Record<MaintainEvent["via"], string> = { github: "GitHub", discord: "Discord", agent: "agent", dashboard: "AutoCraft", cli: "CLI" };

type Row = { t: "said"; at: string; e: MaintainEvent } | { t: "trace"; at: string; e: TraceEvent };

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

export function History({ repo, number, kind, said }: { repo: string; number: number; kind: ItemKind; said: MaintainEvent[] }) {
  const [all, setAll] = useState<"main" | "all">("main");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const { data, error } = useQuery(`item-trace:v2:${repo}#${number}`, async (a) => {
    const r = await a.itemTrace(repo, number, { limit: 300 });
    if ("unchanged" in r) throw new Error("unexpected empty answer");
    return r;
  });
  const rows = useMemo(() => {
    const trace = (data?.events ?? []).filter((e) => all === "all" || MAIN.has(e.kind) || e.actor.type === "person");
    const out: Row[] = [...said.map((e) => ({ t: "said" as const, at: e.at, e })), ...trace.map((e) => ({ t: "trace" as const, at: e.at, e }))];
    return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }, [data, said, all]);
  const toggle = (id: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  return (
    <div className="flex flex-col gap-2 px-4 pb-4">
      <Segmented
        label={t("History shows")}
        value={all}
        onChange={setAll}
        className="w-fit max-md:[&>button]:h-11"
        options={[{ value: "main", label: t("Main events") }, { value: "all", label: t("Every step") }]}
      />
      <ErrorLine error={error?.message} />
      {!data && !error && <p className="text-sm text-ink/70" role="status">{t("Loading…")}</p>}
      {data && rows.length === 0 && <p className="text-sm text-ink/70">{t("Nothing yet.")}</p>}
      {rows.length > 0 && (
        <ol aria-label={t("History, oldest first")} className="rounded-lg border border-line bg-panel">
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
