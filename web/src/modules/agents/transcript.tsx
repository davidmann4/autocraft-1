// The full transcript of one attempt of a model call: model text, thinking, each tool call with its arguments and result.
import { useState } from "react";
import { Link } from "react-router-dom";
import { BrainIcon, ChatTextIcon, DownloadSimpleIcon, FlagCheckeredIcon, GearSixIcon, TerminalWindowIcon, UserIcon, WrenchIcon } from "@phosphor-icons/react";
import { t } from "../../../../src/i18n/index.ts";
import { useQuery } from "../../api/client";
import type { AgentRunTranscript, TranscriptEntry, TranscriptView } from "../../api/types";
import type { ViewProps } from "../../registry/types";
import { num } from "../../lib/format";
import { Badge } from "../../ui/atoms/Badge";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { HostFrame, Page } from "../../ui/organisms/Page";
import { cn } from "../../ui/cn";

const KIND: Record<TranscriptEntry["kind"], { label: string; Icon: typeof ChatTextIcon }> = {
  system: { label: "Session", Icon: GearSixIcon },
  user: { label: "Prompt", Icon: UserIcon },
  text: { label: "Model", Icon: ChatTextIcon },
  thinking: { label: "Thinking", Icon: BrainIcon },
  tool: { label: "Tool call", Icon: WrenchIcon },
  result: { label: "Tool result", Icon: TerminalWindowIcon },
  final: { label: "Result", Icon: FlagCheckeredIcon },
  event: { label: "Event", Icon: GearSixIcon },
};
const OUTCOME: Record<AgentRunTranscript["outcome"], { label: string; tone: "ok" | "bad" | "warn" }> = {
  done: { label: "Done", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  refused: { label: "Refused", tone: "warn" },
};
/** Lines of a long tool call or result shown before "Show all". */
const FOLD_LINES = 14;

const clock = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(11, 19) : "");
export const kib = (n: number) => (n < 1024 * 1024 ? `${num(Math.max(1, Math.round(n / 1024)))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** One line per transcript of a run, linking to its page (the run detail's Transcripts list). */
export function TranscriptLinks({ runId, transcripts, off }: { runId: number; transcripts: AgentRunTranscript[]; off?: boolean }) {
  if (transcripts.length === 0 && !off) return null;
  return (
    <section aria-label={t("Transcripts")}>
      <h3 className="text-xs font-semibold text-ink/65">{t("Transcripts")}</h3>
      {off && <p className="mt-1 text-sm text-ink/65">{t("Transcripts are off for this instance.")}</p>}
      {transcripts.length > 0 && <ul className="mt-1 divide-y divide-line rounded border border-line">
        {transcripts.map((x) => (
          <li key={x.id}>
            <Link to={`/agents/${runId}/transcripts/${x.id}`} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm hover:bg-ink/[0.04]">
              <span className="font-medium text-accent-ink">
                {t("Attempt")} {x.attempt + 1}
              </span>
              <Badge tone={OUTCOME[x.outcome].tone}>{t(OUTCOME[x.outcome].label)}</Badge>
              <span className="num text-ink/65">
                {num(x.lines)} {t("events")} · {num(x.toolCount)} {t("tool calls")} · {kib(x.bytes)}
              </span>
            </Link>
          </li>
        ))}
      </ul>}
    </section>
  );
}

function EntryText({ e }: { e: TranscriptEntry }) {
  const lines = e.text.split("\n");
  const foldable = (e.kind === "tool" || e.kind === "result" || e.kind === "event") && lines.length > FOLD_LINES;
  const [open, setOpen] = useState(false);
  const shown = foldable && !open ? lines.slice(0, FOLD_LINES).join("\n") : e.text;
  const mono = e.kind !== "text" && e.kind !== "thinking" && e.kind !== "user";
  return (
    <>
      {e.text && (
        <pre className={cn("whitespace-pre-wrap break-words text-sm leading-relaxed", mono ? "code rounded border border-line bg-sunken p-2 text-xs" : "font-sans", e.kind === "thinking" && "text-ink/70", e.isError && "border-bad/40")}>
          {shown}
        </pre>
      )}
      {(foldable || (e.truncated ?? 0) > 0) && (
        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-ink/60">
          {foldable && (
            <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="min-h-7 font-medium text-accent-ink hover:underline max-md:min-h-11">
              {open ? t("Show less") : `${t("Show all")} (${num(lines.length)} ${t("lines")})`}
            </button>
          )}
          {(e.truncated ?? 0) > 0 && (
            <span>
              {num(e.truncated!)} {t("more characters in the download")}
            </span>
          )}
        </div>
      )}
    </>
  );
}

function Entry({ e }: { e: TranscriptEntry }) {
  const k = KIND[e.kind];
  return (
    <li className={cn("flex gap-3 py-3", e.sub && "border-l-2 border-line pl-3")}>
      <k.Icon aria-hidden className={cn("mt-0.5 shrink-0 text-[16px]", e.isError ? "text-bad" : "text-ink/55")} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <span className="font-semibold text-ink/80">{t(k.label)}</span>
          {e.name && <span className="code text-ink">{e.name}</span>}
          {e.sub && <span className="text-ink/60">{t("subagent")}</span>}
          {e.isError && <span className="font-medium text-bad">{t("error")}</span>}
          <span className="num ml-auto text-ink/50">{clock(e.at)}</span>
        </div>
        <div className="mt-1">
          <EntryText e={e} />
        </div>
      </div>
    </li>
  );
}

function TranscriptBody({ v }: { v: TranscriptView }) {
  const x = v.transcript;
  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <Link to={`/agents/${v.runId}`} className="num font-medium text-accent-ink hover:underline">
          {t("Run")} {v.runId}
        </Link>
        <span>
          {t("Attempt")} {x.attempt + 1}
        </span>
        <Badge tone={OUTCOME[x.outcome].tone}>{t(OUTCOME[x.outcome].label)}</Badge>
        <span className="num text-ink/65">
          {num(x.lines)} {t("events")} · {num(x.toolCount)} {t("tool calls")} · {kib(x.rawBytes)}
        </span>
        <a
          href={`/api/agents/${v.runId}/transcripts/${x.id}/download`}
          download
          className="inline-flex h-9 items-center gap-1.5 rounded border border-line px-3 text-sm font-medium hover:bg-ink/[0.04] max-md:h-11 md:ml-auto"
        >
          <DownloadSimpleIcon aria-hidden />
          {t("Download JSONL")}
        </a>
      </div>
      <ol className="mt-3 divide-y divide-line">
        {v.entries.map((e, i) => (
          <Entry key={i} e={e} />
        ))}
      </ol>
      {v.omitted > 0 && (
        <p className="mt-2 text-sm text-ink/60">
          {num(v.omitted)} {t("more entries in the download")}
        </p>
      )}
    </>
  );
}

export function TranscriptPage({ params }: ViewProps) {
  const runId = Number(params.id), id = Number(params.tid);
  const q = useQuery<TranscriptView>(`transcript-${runId}-${id}`, (a) => a.agents.transcript(runId, id));
  return (
    <HostFrame.Provider value={{ title: t("Transcript"), back: { to: `/agents/${runId}`, label: `${t("Run")} ${runId}` } }}>
      <Page title={t("Transcript")}>
        {q.error && <ErrorLine error={q.error.message} className="mt-3" />}
        {!q.data && !q.error && <p className="mt-3 text-sm text-ink/50">{t("Loading.")}</p>}
        {q.data && <TranscriptBody v={q.data} />}
      </Page>
    </HostFrame.Provider>
  );
}
