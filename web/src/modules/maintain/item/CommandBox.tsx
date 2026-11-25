// The item's command box: the same words as a GitHub comment, Discord or the agent. The reply is the confirmation line, or what
// AutoCraft understood when nothing ran; it is announced to screen readers.
import { useState } from "react";
import { PaperPlaneRightIcon } from "@phosphor-icons/react";
import { t } from "../../../../../src/i18n/index.ts";
import { useApi } from "../../../api/client";
import type { MaintainReply } from "../../../api/types";
import { Button } from "../../../ui/atoms/Button";
import { Textarea } from "../../../ui/atoms/Textarea";
import { cn } from "../../../ui/cn";

export function CommandBox({ repo, number, placeholder }: { repo: string; number: number; placeholder: string }) {
  const api = useApi();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [reply, setReply] = useState<MaintainReply | null>(null);
  const send = async () => {
    const said = text.trim();
    if (!said || sending) return;
    setSending(true);
    try {
      const r = await api.maintainItem.command(repo, number, said);
      setReply(r);
      if (r.ok) setText("");
    } catch (e) {
      setReply({ ok: false, lines: [e instanceof Error ? e.message : String(e)] });
    } finally {
      setSending(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <Textarea
        rows={2}
        aria-label={t("Command")}
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
        className="code w-full resize-y text-sm"
      />
      <Button type="submit" variant="primary" size="lg" icon={PaperPlaneRightIcon} className="w-fit" loading={sending} disabled={!text.trim()}>
        {t("Send")}
      </Button>
      <div aria-live="polite">
        {reply?.lines.map((l) => (
          <p key={l} className={cn("text-sm", reply.ok ? "text-ink/80" : "text-bad")}>
            {l}
          </p>
        ))}
      </div>
    </form>
  );
}
