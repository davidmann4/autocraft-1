import { CircleNotchIcon } from "@phosphor-icons/react";

/** The step AutoCraft is running now, at the end of the conversation. */
export function WorkingLine({ line }: { line: string }) {
  return (
    <li className="flex items-center gap-2.5 text-sm text-ink/70">
      <CircleNotchIcon aria-hidden weight="bold" className="shrink-0 animate-spin text-accent-ink" />
      <span>{line}</span>
    </li>
  );
}
