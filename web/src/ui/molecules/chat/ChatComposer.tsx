// The reply box under a conversation: the same words as a GitHub comment to AutoCraft. Enter sends, Shift+Enter starts a new line.
import { useRef, useState } from "react";
import { ArrowUpIcon, CircleNotchIcon } from "@phosphor-icons/react";
import { t } from "../../../../../src/i18n/index.ts";
import { ErrorLine } from "../../atoms/ErrorLine";
import { Textarea } from "../../atoms/Textarea";

/** `blocked`: why the reader cannot write here; the box is then disabled and says why. */
export function ChatComposer({ open, blocked, onSend }: { open: boolean; blocked?: string | null; onSend: (text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const send = async () => {
    const v = text.trim();
    if (!v || busy || blocked) return;
    setBusy(true);
    setError(null);
    try {
      await onSend(v);
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      box.current?.focus();
    }
  };
  return (
    <div className="relative shrink-0 before:pointer-events-none before:absolute before:inset-x-0 before:-top-6 before:h-6 before:bg-gradient-to-t before:from-panel before:to-transparent">
      <div className="mx-auto w-full max-w-[784px] px-3 pb-3 md:px-6 md:pb-5">
        <div className="flex items-end gap-2 rounded-xl border border-line-strong bg-sunken p-1.5 shadow-[0_1px_2px_rgb(0_0_0/0.06)] focus-within:border-accent-ink/70">
          <Textarea
            ref={box}
            rows={1}
            value={text}
            disabled={!!blocked}
            aria-label={open ? t("Reply yes, or say what to do instead") : t("Reply to AutoCraft")}
            placeholder={blocked ?? (open ? t("Reply yes, or say what to do instead…") : t("Reply to AutoCraft…"))}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            className="max-h-40 min-h-9 resize-none border-0 bg-transparent px-2.5 py-1.5 text-base md:text-md [field-sizing:content] focus:border-0"
          />
          <button
            type="button"
            aria-label={t("Send")}
            disabled={!text.trim() || busy || !!blocked}
            onClick={() => void send()}
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-white disabled:bg-ink/[0.12] disabled:text-ink/50 max-md:size-11"
          >
            {busy ? <CircleNotchIcon aria-hidden className="animate-spin" /> : <ArrowUpIcon aria-hidden weight="bold" />}
          </button>
        </div>
        <ErrorLine error={error ?? undefined} />
      </div>
    </div>
  );
}
