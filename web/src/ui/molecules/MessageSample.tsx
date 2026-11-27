import type { ReactNode } from "react";
import { cn } from "../cn";

const tones = { neutral: "border-line-strong", ok: "border-ok", asks: "border-warn", bad: "border-bad" } as const;

/** A sample of a message or reply, quoted as a block with a coloured left edge; `note` is a line under it that says what it does. */
export function MessageSample({ children, note, tone = "neutral", className }: { children: ReactNode; note?: ReactNode; tone?: keyof typeof tones; className?: string }) {
  return (
    <div className={cn("min-w-0 rounded-r border-l-4 bg-sunken px-3 py-2 text-sm leading-5", tones[tone], className)}>
      <div className="break-words">{children}</div>
      {note && <div className="mt-0.5 text-ink/70">{note}</div>}
    </div>
  );
}
