import { ArrowDownIcon, ChatCircleIcon } from "@phosphor-icons/react";
import { Fragment } from "react";
import { t } from "../../../../src/i18n/index.ts";
import { cn } from "../cn";

/** `you`: what the person types; `asks`: AutoCraft stops and asks; `done`: where it ends. `when` names the case of a branch. */
export type FlowStep = { text: string; kind?: "step" | "you" | "asks" | "done"; when?: string };
/** One step, or the cases the flow splits into after the step before. */
export type FlowRow = FlowStep | FlowStep[];

const tone: Record<NonNullable<FlowStep["kind"]>, string> = {
  step: "border-line-strong bg-raised",
  you: "code border-accent-ink/50 bg-accent/10",
  asks: "border-warn/50 bg-warn/10",
  done: "border-ok/50 bg-ok/10",
};

function Box({ s }: { s: FlowStep }) {
  const kind = s.kind ?? "step";
  return (
    <div className={cn("w-full min-w-0 rounded border px-3 py-1.5 text-sm leading-5", tone[kind])}>
      {s.when && <span className="block text-xs font-semibold text-ink/70">{s.when}</span>}
      {kind === "asks" && (
        <span className="font-semibold text-warn">
          <ChatCircleIcon aria-hidden className="mr-1 inline align-[-2px]" />
          {t("Asks you:")}{" "}
        </span>
      )}
      {s.text}
    </div>
  );
}

/** A flow of steps drawn top to bottom, as a labelled list. A step where AutoCraft asks says so in words, not by colour alone. */
export function StepFlow({ label, rows }: { label: string; rows: FlowRow[] }) {
  return (
    <ol aria-label={label} className="flex max-w-md flex-col">
      {rows.map((row, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <li aria-hidden className="flex h-6 items-center pl-4 text-ink/50">
              <ArrowDownIcon />
            </li>
          )}
          <li>
            {Array.isArray(row) ? (
              <ul aria-label={t("Cases")} className="grid grid-cols-2 gap-2 max-[360px]:grid-cols-1">
                {row.map((s, j) => (
                  <li key={j} className="flex">
                    <Box s={s} />
                  </li>
                ))}
              </ul>
            ) : (
              <Box s={row} />
            )}
          </li>
        </Fragment>
      ))}
    </ol>
  );
}
