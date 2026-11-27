import { useState } from "react";
import { DiscordLogoIcon } from "@phosphor-icons/react";
import { t } from "../../../../../src/i18n/index.ts";
import type { ChatEntry } from "../../../api/types";
import { MessageTime } from "../../atoms/MessageTime";
import { safeHref } from "../../safeHref";

type Discord = Extract<ChatEntry, { t: "discord" }>;

const LINE = "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs text-ink/70 hover:bg-ink/[0.05] hover:text-ink max-md:min-h-11";
const channelName = (c: string | null) => (c ? `#${c}` : t("a Discord channel"));

/** Mentions of the item on Discord. One opens its message in a new tab; several fold into one line that lists them. */
export function DiscordLine({ e }: { e: Discord }) {
  const [open, setOpen] = useState(false);
  const [first] = e.links;
  if (!first) return null;
  if (e.links.length === 1)
    return (
      <li className="flex justify-center">
        <a href={safeHref(first.url)} target="_blank" rel="noopener noreferrer" className={LINE}>
          <DiscordLogoIcon aria-hidden />
          {t("Mentioned on Discord")}
          <span aria-hidden>·</span>
          {channelName(first.channel)}
          <span aria-hidden>·</span>
          <MessageTime iso={first.at} />
        </a>
      </li>
    );
  const list = `chat-discord-${e.id}`;
  return (
    <li className="flex flex-col items-center">
      <button type="button" aria-expanded={open} aria-controls={open ? list : undefined} onClick={() => setOpen((o) => !o)} className={LINE}>
        <DiscordLogoIcon aria-hidden />
        {t("{n} mentions on Discord", { n: e.links.length })}
        <span aria-hidden>·</span>
        <MessageTime iso={e.at} />
      </button>
      {open && (
        <ul id={list} className="flex flex-col items-center">
          {e.links.map((l) => (
            <li key={l.url}>
              <a href={safeHref(l.url)} target="_blank" rel="noopener noreferrer" className={LINE}>
                {channelName(l.channel)}
                <span aria-hidden>·</span>
                <MessageTime iso={l.at} />
              </a>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
