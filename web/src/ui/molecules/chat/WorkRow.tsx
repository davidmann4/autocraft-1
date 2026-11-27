import { useState } from "react";
import { CaretRightIcon, CheckCircleIcon, CircleNotchIcon, XCircleIcon } from "@phosphor-icons/react";
import { t } from "../../../../../src/i18n/index.ts";
import type { ChatEntry } from "../../../api/types";
import { MessageTime } from "../../atoms/MessageTime";
import { cn } from "../../cn";
import { Facts } from "../Facts";
import { ShotStrip } from "./ShotStrip";

type Work = Extract<ChatEntry, { t: "work" }>;

const LOOK = {
  done: [CheckCircleIcon, "text-ok", t("done")],
  running: [CircleNotchIcon, "text-accent-ink animate-spin", t("running")],
  failed: [XCircleIcon, "text-bad", t("failed")],
} as const;

const seconds = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`);

/** Something AutoCraft did, as a tool-call row: state, title, model, time, cost and outcome. Opens to its detail and to the event. */
export function WorkRow({ e, onEvent }: { e: Work; onEvent: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [Icon, tone, word] = LOOK[e.state];
  const time = e.seconds !== null ? seconds(e.seconds) : null;
  const cost = e.costUsd !== null ? `$${e.costUsd.toFixed(2)}` : null;
  const meta = [e.model, time, cost, e.outcome].filter(Boolean).join(" · ");
  const body = `chat-work-${e.id}`;
  return (
    <li className="rounded-md">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? body : undefined}
        onClick={() => setOpen((o) => !o)}
        className="-mx-2 flex w-[calc(100%+1rem)] items-start gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-ink/[0.05] max-md:min-h-11 max-md:items-center"
      >
        <Icon aria-hidden weight={e.state === "running" ? "bold" : "fill"} className={cn("mt-[3px] shrink-0 max-md:mt-0", tone)} />
        <span className="min-w-0 flex-1">
          <span className="font-medium">{e.title}</span>
          <span className="sr-only">, {word}</span>
          {meta && <span className="text-ink/70"> · {meta}</span>}
        </span>
        <CaretRightIcon aria-hidden className={cn("mt-[3px] shrink-0 text-ink/60 transition-transform duration-fast max-md:mt-0", open && "rotate-90")} />
      </button>
      {open && (
        <div id={body} className="mb-1 ml-[7px] mt-0.5 flex flex-col gap-2 border-l-2 border-line py-1 pl-[17px]">
          <Facts
            rows={[
              [t("Model"), e.model],
              [t("Time"), time ?? (e.state === "running" ? t("running") : null)],
              [t("Cost"), cost],
              [t("Outcome"), e.outcome],
              ...e.detail,
              [t("Started"), <MessageTime key="s" iso={e.at} />],
            ]}
          />
          {e.eventId && (
            <button type="button" onClick={() => onEvent(e.eventId!)} className="w-fit rounded text-sm font-medium text-accent-ink hover:underline max-md:min-h-11">
              {t("Open in Events")}
            </button>
          )}
          {e.shots && e.shots.length > 0 && <ShotStrip shots={e.shots} />}
        </div>
      )}
    </li>
  );
}

/** Consecutive work rows of one kind (same title) from this many on fold into one row. */
export const FOLD_FROM = 3;

/** A run of work rows of one kind as one row, "Title ×n"; it opens to the rows themselves, each still reachable. */
export function WorkGroup({ items, onEvent }: { items: Work[]; onEvent: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const state = items.some((e) => e.state === "failed") ? "failed" : items.some((e) => e.state === "running") ? "running" : "done";
  const [Icon, tone, word] = LOOK[state];
  const failed = items.filter((e) => e.state === "failed").length;
  const body = `chat-work-group-${items[0]!.id}`;
  return (
    <li className="rounded-md">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? body : undefined}
        onClick={() => setOpen((o) => !o)}
        className="-mx-2 flex w-[calc(100%+1rem)] items-start gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-ink/[0.05] max-md:min-h-11 max-md:items-center"
      >
        <Icon aria-hidden weight={state === "running" ? "bold" : "fill"} className={cn("mt-[3px] shrink-0 max-md:mt-0", tone)} />
        <span className="min-w-0 flex-1">
          <span className="font-medium">{items[0]!.title} ×{items.length}</span>
          <span className="sr-only">, {word}</span>
          {failed > 0 && <span className="text-ink/70"> · {t("{n} failed", { n: failed })}</span>}
        </span>
        <CaretRightIcon aria-hidden className={cn("mt-[3px] shrink-0 text-ink/60 transition-transform duration-fast max-md:mt-0", open && "rotate-90")} />
      </button>
      {open && (
        <ul id={body} className="mb-1 ml-[7px] mt-0.5 flex flex-col gap-1 border-l-2 border-line py-1 pl-[17px]">
          {items.map((e) => <WorkRow key={e.id} e={e} onEvent={onEvent} />)}
        </ul>
      )}
    </li>
  );
}
