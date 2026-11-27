import { GithubLogoIcon } from "@phosphor-icons/react";
import { t } from "../../../../../src/i18n/index.ts";
import type { ChatEntry } from "../../../api/types";
import { MessageTime } from "../../atoms/MessageTime";

type Github = Extract<ChatEntry, { t: "github" }>;

/** GitHub activity not addressed to AutoCraft, folded into one line that opens the GitHub tab. */
export function GithubLine({ e, onGithub }: { e: Github; onGithub: () => void }) {
  const n = e.count ?? e.lines.length;
  return (
    <li className="flex justify-center">
      <button
        type="button"
        onClick={onGithub}
        title={e.lines.join("\n")}
        className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs text-ink/70 hover:bg-ink/[0.05] hover:text-ink max-md:min-h-11"
      >
        <GithubLogoIcon aria-hidden />
        {n === 1 ? t("1 update on GitHub") : t("{n} updates on GitHub", { n })}
        <span aria-hidden>·</span>
        <MessageTime iso={e.at} />
      </button>
    </li>
  );
}
