import type { ReactNode } from "react";
import { t } from "../../../../../src/i18n/index.ts";
import type { ChatEntry } from "../../../api/types";
import { Logo } from "../../atoms/Logo";
import { MessageTime } from "../../atoms/MessageTime";
import { messageTime } from "../../../lib/format";
import { Markdown } from "../Markdown";
import { VEILED } from "./ChatBubble";

type Reply = Extract<ChatEntry, { t: "reply" }>;

/** The question AutoCraft is waiting on, set apart from the text and named by the question itself. */
export function QuestionBlock({ ask }: { ask: NonNullable<Reply["ask"]> }) {
  return (
    <div role="region" aria-label={ask.question || t("Question for {who}", { who: ask.to.join(", ") })} className="mt-1 flex flex-col gap-1 rounded-xl border border-accent/50 bg-accent/[0.08] px-4 py-3">
      {ask.question ? <p className="text-lg font-semibold leading-6">{ask.question}</p> : <p className="text-sm italic leading-6 text-ink/70">{VEILED()}</p>}
      <p className="text-xs text-ink/70">{t("Asks {who}", { who: ask.to.map((l) => `@${l}`).join(", ") })}</p>
    </div>
  );
}

/** One AutoCraft message: text, numbered findings, and its question (boxed while it is the open one). */
export function AutoCraftMessage({ e, open }: { e: Reply; open: boolean }) {
  return (
    <li className="flex flex-col gap-2 text-md leading-6">
      {e.body ? <Markdown source={e.body} className="!text-md !leading-6" /> : !e.ask && <p className="text-sm italic text-ink/70">{VEILED()}</p>}
      {e.findings.length > 0 && (
        <ol aria-label={t("Findings")} className="flex flex-col gap-2">
          {e.findings.map((f) => (
            <li key={f.n} className="flex gap-2.5">
              <span className="code w-4 shrink-0 text-right font-semibold">{f.n}</span>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                {f.title}
                {f.major && <span className="ml-1.5 rounded-full border border-bad/50 px-1.5 text-2xs font-semibold text-bad">{t("major")}</span>}
                {f.file && <span className="code block text-xs text-ink/70">{f.file}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
      {e.ask && (open ? <QuestionBlock ask={e.ask} /> : <p className={e.ask.question ? "font-semibold" : "text-sm italic text-ink/70"}>{e.ask.question || VEILED()}</p>)}
    </li>
  );
}

/** AutoCraft's consecutive messages and work rows: one turn, with the mark at its start. */
export function AutoCraftTurn({ at, text, children }: { at: string; /** The turn's first words, for its accessible name. */ text: string; children: ReactNode }) {
  return (
    <li aria-label={t("AutoCraft, {time}: {text}", { time: messageTime(at), text })} className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-ink/70">
        <Logo size={18} />
        <span className="text-sm font-semibold text-ink">AutoCraft</span>
        <MessageTime iso={at} />
      </div>
      <ul className="flex flex-col gap-2 md:pl-[26px]">{children}</ul>
    </li>
  );
}
