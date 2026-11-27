// The Agents page: model calls running now, recent calls with server-side filters and keyset paging,
// and a detail panel with the rendered prompt and the output. Operators and maintainers also filter the
// calls a model's safety filter refused, with their counts per prompt, repo, model and Task Runner user.
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Dialog } from "radix-ui";
import { CaretDownIcon, CaretRightIcon, XIcon } from "@phosphor-icons/react";
import { usePagedQuery, useQuery } from "../../api/client";
import type { AgentRun, AgentRunDetail, AgentRunFilter, AgentRunPage, AgentRunRefusal, AgentRunState, RefusalGroup, RefusalWindow } from "../../api/types";
import { t } from "../../../../src/i18n/index.ts";
import { useUser } from "../../shell/UserContext";
import { can } from "../../registry/permissions";
import { Chip } from "../../ui/atoms/Chip";
import { Segmented } from "../../ui/molecules/Segmented";
import type { ViewProps } from "../../registry/types";
import { nowMs, num, span } from "../../lib/format";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { useNow } from "../../lib/useNow";
import { Badge, type Tone } from "../../ui/atoms/Badge";
import { Button } from "../../ui/atoms/Button";
import { RemoteVia } from "../../ui/molecules/RemoteVia";
import { ItemRef } from "../../ui/molecules/ItemRef";
import { cn } from "../../ui/cn";
import { Block, ErrorLine, Page, selectCls, useUrlState } from "../admin/parts";
import { RunsQueueSwitch } from "./queue";
import { TranscriptLinks } from "./transcript";

const STATE_TONE: Record<AgentRunState, Tone> = { running: "accent", done: "ok", failed: "bad" };
const STATE_LABEL: Record<AgentRunState, string> = { running: "Running", done: "Done", failed: "Failed" };

const tokensOf = (r: AgentRun) => (r.inputTokens === null && r.outputTokens === null ? null : (r.inputTokens ?? 0) + (r.outputTokens ?? 0));
const elapsed = (r: AgentRun) => span((r.endedAt ? Date.parse(r.endedAt) : nowMs()) - Date.parse(r.startedAt));

/** The items a run works on, with "+N more" past the ones the API lists. */
function Items({ r, max = 3, expandable }: { r: AgentRun; max?: number; expandable?: boolean }) {
  const [all, setAll] = useState(false);
  if (expandable) max = all ? r.items.length : max;
  const shown = r.items.slice(0, max);
  const more = r.itemCount - shown.length;
  return (
    <span className="flex flex-col items-start gap-0.5">
      {shown.map((i) => (
        <ItemRef key={`${i.repo}#${i.number}`} repo={i.repo} number={i.number} kind={i.kind} state={i.state} title={i.title} size="sm" className="relative z-10 w-fit max-w-full" />
      ))}
      {more > 0 &&
        (expandable && !all && r.items.length > shown.length ? (
          <button onClick={() => setAll(true)} className="relative z-10 text-xs text-accent-ink hover:underline max-md:min-h-11">
            +{num(more)} more
          </button>
        ) : (
          <span className="text-xs text-ink/50">+{num(more)} more</span>
        ))}
    </span>
  );
}

const who = (r: AgentRun): ReactNode => (r.provider === "jev" ? "Jev" : r.via ? <RemoteVia via={r.via} /> : "–");

// ---- running now ---------------------------------------------------------------

function RunningNow({ selected }: { selected?: number }) {
  const q = useQuery<AgentRunPage>("agents-running", (a) => a.agents.list({ state: "running" }));
  const runs = q.data?.runs ?? [];
  useNow(runs.length ? 1000 : undefined);
  return (
    <Block flush title={<>Running now {q.data && <span className="num ml-1 font-normal text-ink/50">{runs.length}</span>}</>} aside="live">
      <ErrorLine error={q.error?.message} className="p-4" />
      {q.data && runs.length === 0 && <p className="p-4 text-sm text-ink/55">No agent is running.</p>}
      <ul>
        {runs.map((r) => (
          <li key={r.id} className={cn("relative border-t border-line px-4 py-2.5 first:border-t-0 hover:bg-ink/[0.03]", selected === r.id && "bg-accent/10")}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Link to={`/agents/${r.id}`} aria-current={selected === r.id} className="code text-sm font-medium after:absolute after:inset-0">
                {r.step}
              </Link>
              <span className="text-xs text-ink/50">stage {r.stage}</span>
              <Badge tone="accent">{r.model}</Badge>
              <span className="text-xs text-ink/70">{who(r)}</span>
              <span className="num ml-auto text-xs text-ink/70">
                {elapsed(r)} · {tokensOf(r) === null ? "–" : `${num(tokensOf(r)!)} tok`}
              </span>
            </div>
            <div className="mt-1">
              <Items r={r} />
            </div>
            {r.progress && <p className="mt-1 text-xs text-ink/45 [overflow-wrap:anywhere]">{r.progress}</p>}
          </li>
        ))}
      </ul>
    </Block>
  );
}

// ---- recent runs ---------------------------------------------------------------

function useRecent(filter: Omit<AgentRunFilter, "cursor">) {
  const q = usePagedQuery(`agents-recent:${JSON.stringify(filter)}`, (api, cursor) => api.agents.list({ ...filter, cursor }), (p) => p.nextCursor);
  return { rows: q.pages?.flatMap((p) => p.runs) ?? [], loading: q.loading || q.loadingMore, error: q.error?.message, more: q.hasMore, loadMore: q.loadMore };
}

const WINDOWS: RefusalWindow[] = ["24h", "7d", "30d"];
const WINDOW_LABEL: Record<RefusalWindow, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };

function Filters({ f, update, staff }: { f: Record<string, string | undefined>; update: (p: Record<string, string | null>) => void; staff: boolean }) {
  const steps = useQuery("agents-steps", (a) => a.pipeline.overview());
  const repos = useQuery("agents-repos", (a) => a.repos());
  const sel = (label: string, key: string, opts: { value: string; label: string }[]) => (
    <label className="flex items-center gap-1.5 text-xs text-ink/60">
      <span className="max-md:sr-only">{label}</span>
      <select aria-label={label} value={f[key] ?? ""} onChange={(e) => update({ [key]: e.target.value || null })} className={cn(selectCls, "max-md:max-w-[44vw]")}>
        <option value="">{`All ${label.toLowerCase()}s`}</option>
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2">
      {sel("Step", "step", (steps.data?.steps ?? []).filter((s) => ["classify-new", "classify-all", "areas-rescan"].includes(s.name)).map((s) => ({ value: s.name, label: s.name })).concat([{ value: "opus-review", label: "opus-review" }]).filter((o, i, a) => a.findIndex((x) => x.value === o.value) === i))}
      {sel("State", "state", [{ value: "done", label: "Done" }, { value: "failed", label: "Failed" }])}
      {sel("Repo", "repo", (repos.data ?? []).map((r) => ({ value: r, label: r })))}
      {staff && (
        <Chip active={f.refused === "1"} onClick={() => update({ refused: f.refused === "1" ? null : "1", window: null })} className="max-md:h-11">
          {t("Refused")}
        </Chip>
      )}
      {staff && f.refused === "1" && (
        <Segmented
          label={t("Time range")}
          value={(f.window as RefusalWindow | undefined) ?? "7d"}
          options={WINDOWS.map((w) => ({ value: w, label: t(WINDOW_LABEL[w]) }))}
          onChange={(w) => update({ window: w === "7d" ? null : w })}
        />
      )}
    </div>
  );
}

// ---- refused calls -------------------------------------------------------------

function GroupTable({ title, rows, code }: { title: string; rows: RefusalGroup[]; code?: boolean }) {
  const shown = rows.slice(0, 8);
  return (
    <table className="num w-full text-sm">
      <caption className="pb-1 text-left text-xs font-semibold text-ink/65">{title}</caption>
      <thead className="text-xs text-ink/55">
        <tr>
          <th scope="col" className="sr-only">{title}</th>
          <th scope="col" className="h-7 w-16 px-2 text-right font-medium">{t("Refused")}</th>
          <th scope="col" className="h-7 w-16 px-2 text-right font-medium">{t("Failed")}</th>
        </tr>
      </thead>
      <tbody>
        {shown.map((g) => (
          <tr key={String(g.key)} className="border-t border-line">
            <th scope="row" className={cn("max-w-0 truncate py-1 pr-2 text-left font-normal", code && g.key !== null && "code text-xs")} title={g.key ?? undefined}>
              {g.key ?? <span className="text-ink/50">{t("none")}</span>}
            </th>
            <td className="px-2 text-right">{num(g.n)}</td>
            <td className={cn("px-2 text-right", g.failed > 0 ? "text-bad" : "text-ink/50")}>{num(g.failed)}</td>
          </tr>
        ))}
        {rows.length > shown.length && (
          <tr className="border-t border-line">
            <td colSpan={3} className="py-1 text-xs text-ink/50">{t("{n} more", { n: num(rows.length - shown.length) })}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** Counts of the refused calls in the range, so a cause they share stands out. */
function RefusalCounts({ window }: { window: RefusalWindow }) {
  const q = useQuery(`agents-refusals:${window}`, (a) => a.agents.refusals(window));
  const b = q.data;
  return (
    <div className="border-b border-line px-4 py-3">
      <ErrorLine error={q.error?.message} />
      {b && (
        <>
          <p className="num text-sm" aria-live="polite">
            {t("{n} refused in the last {range}", { n: num(b.total), range: t(WINDOW_LABEL[window]) })}
            {b.failed > 0 && <span className="text-bad"> · {t("{n} with no other Task Runner or tier", { n: num(b.failed) })}</span>}
            {b.capped && <span className="text-ink/55"> · {t("counts cover the newest {n}", { n: num(b.total) })}</span>}
          </p>
          {b.total > 0 && (
            <div className="mt-3 grid items-start gap-x-6 gap-y-4 md:grid-cols-2">
              <GroupTable title={t("Prompt")} rows={b.byPrompt} code />
              <GroupTable title={t("Repo")} rows={b.byRepo} />
              <GroupTable title={t("Model")} rows={b.byModel} />
              <GroupTable title={t("Task Runner user")} rows={b.byLogin} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** What became of a refused call: its retry's state (linked to that run), or that nothing else could take it. */
function RetryOutcome({ refusal }: { refusal: AgentRunRefusal }) {
  if (refusal.outcome === "failed") return <Badge tone="bad">{t("Not retried")}</Badge>;
  if (!refusal.retry) return <span className="text-xs text-ink/55">{t("Retried")}</span>;
  return (
    <Link to={`/agents/${refusal.retry.id}${location.search}`} className="relative z-10 inline-flex items-center max-md:min-h-11">
      <Badge tone={STATE_TONE[refusal.retry.state]}>{t(STATE_LABEL[refusal.retry.state])}</Badge>
      <span className="sr-only"> ({t("retry, run {id}", { id: refusal.retry.id })})</span>
    </Link>
  );
}

function RecentRuns({ selected }: { selected?: number }) {
  const { state: f, update } = useUrlState();
  const staff = can(useUser(), "staff");
  const refused = staff && f.refused === "1";
  const window = refused ? ((f.window as RefusalWindow | undefined) ?? "7d") : undefined;
  const recent = useRecent({ state: (f.state as AgentRunState | undefined) ?? "recent", step: f.step, repo: f.repo, limit: 50, ...(refused && { refused, window }) });
  // A run open in the detail panel leaves the list narrow; the panel shows its model, Task Runner and tokens, so the list drops them for the items.
  const open = selected !== undefined;
  useNow(recent.rows.some((r) => r.state === "running") ? 1000 : undefined);
  return (
    <Block flush title="Recent runs" aside="newest first">
      <Filters f={f} update={update} staff={staff} />
      {window && <RefusalCounts window={window} />}
      <ErrorLine error={recent.error} className="p-4" />
      <div className="overflow-x-auto">
        <table className="num w-full text-sm">
          <thead className="bg-ink/[0.03] text-xs text-ink/55">
            <tr>
              <th className="h-8 px-3 text-left font-medium max-md:hidden">Started</th>
              <th className="h-8 px-3 text-left font-medium">Step</th>
              {!refused && !open && <th className="h-8 px-3 text-left font-medium max-md:hidden">Model</th>}
              {!open && <th className="h-8 px-3 text-left font-medium max-md:hidden">Task Runner</th>}
              {refused && <th className="h-8 px-3 text-left font-medium max-md:hidden">{t("Retry")}</th>}
              <th className="h-8 px-3 text-left font-medium">Items</th>
              {!refused && !open && <th className="h-8 px-3 text-right font-medium max-md:hidden">Tokens</th>}
              {!refused && <th className="h-8 px-3 text-left font-medium max-md:hidden">State</th>}
            </tr>
          </thead>
          <tbody>
            {recent.rows.map((r) => (
              <tr key={r.id} className={cn("relative border-t border-line hover:bg-ink/[0.03]", selected === r.id && "bg-accent/10")}>
                <td className="relative z-10 whitespace-nowrap px-3 py-1.5 text-ink/70 max-md:hidden" title={r.startedAt}>
                  <TimeAgo iso={r.startedAt} />
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 code text-xs">
                  <Link to={`/agents/${r.id}${location.search}`} className="after:absolute after:inset-0">
                    {r.step}
                  </Link>
                  {/* Phones: the state and start time under the step, so the items get the width. */}
                  <div className="mt-0.5 flex items-center gap-1.5 font-sans text-ink/60 md:hidden">
                    <span className={cn("inline-block size-2 rounded-full", r.state === "failed" ? "bg-bad" : r.state === "running" ? "bg-accent" : "bg-ok")} role="img" aria-label={STATE_LABEL[r.state]} />
                    <TimeAgo iso={r.startedAt} />
                  </div>
                  {refused && r.refusal && (
                    <div className="mt-0.5 flex items-center gap-1 font-sans text-ink/55 md:hidden">
                      {t("Retry")} <RetryOutcome refusal={r.refusal} />
                    </div>
                  )}
                </td>
                {!refused && !open && <td className="px-3 max-md:hidden">{r.model}</td>}
                {!open && <td className="whitespace-nowrap px-3 text-ink/70 max-md:hidden">{r.provider === "jev" ? "–" : r.via ? <RemoteVia via={r.via} compact /> : "–"}</td>}
                {refused && <td className="whitespace-nowrap px-3 max-md:hidden">{r.refusal && <RetryOutcome refusal={r.refusal} />}</td>}
                <td className="px-3 md:min-w-60">
                  <Items r={r} max={2} />
                </td>
                {!refused && !open && <td className="px-3 text-right max-md:hidden">{tokensOf(r) === null ? "–" : num(tokensOf(r)!)}</td>}
                {!refused && (
                  <td className="px-3 max-md:hidden">
                    <Badge tone={STATE_TONE[r.state]}>{STATE_LABEL[r.state]}</Badge>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!recent.loading && recent.rows.length === 0 && <p className="p-4 text-sm text-ink/55">{refused ? t("No refused runs in this range.") : "No runs match."}</p>}
      {(recent.more || recent.loading) && (
        <div className="border-t border-line p-3">
          <Button size="sm" loading={recent.loading} disabled={!recent.more} onClick={recent.loadMore} className="max-md:h-11">
            Load more
          </Button>
        </div>
      )}
    </Block>
  );
}

// ---- detail --------------------------------------------------------------------

function Collapsible({ title, text, empty, open: initial = false }: { title: string; text: string | null; empty: string; open?: boolean }) {
  const [open, setOpen] = useState(initial);
  const Icon = open ? CaretDownIcon : CaretRightIcon;
  return (
    <div>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-h-7 items-center gap-1 text-xs font-semibold text-ink/65 max-md:min-h-11">
        <Icon className="text-[13px]" />
        {title}
        {text !== null && <span className="num font-normal text-ink/45">{num(text.length)} characters</span>}
      </button>
      {open &&
        (text === null ? (
          <p className="mt-1 text-sm text-ink/55">{empty}</p>
        ) : (
          <pre className="code mt-1 max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-sunken p-3 text-xs leading-relaxed">{text}</pre>
        ))}
    </div>
  );
}

export function RunDetailBody({ id }: { id: number }) {
  const q = useQuery<AgentRunDetail>(`agent-${id}`, (a) => a.agents.get(id));
  const r = q.data;
  useNow(r && !r.endedAt ? 1000 : undefined);
  if (!r) return <div className="p-4">{q.error ? <ErrorLine error={q.error.message} /> : <span className="text-sm text-ink/50">Loading.</span>}</div>;
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATE_TONE[r.state]}>{STATE_LABEL[r.state]}</Badge>
        <span className="code text-sm font-medium">{r.step}</span>
        <Badge tone="accent">{r.model}</Badge>
        <span className="text-sm text-ink/70">{who(r)}</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-ink/55">Prompt</dt>
        <dd>
          <Link to={`/prompts#${r.promptId}`} className="code text-accent-ink hover:underline">
            {r.promptId}
          </Link>{" "}
          <span className="code text-xs text-ink/50">{r.promptVersion}</span>
        </dd>
        <dt className="text-ink/55">Started</dt>
        <dd className="num">
          <TimeAgo iso={r.startedAt} /> · {r.endedAt ? `took ${elapsed(r)}` : `running for ${elapsed(r)}`}
        </dd>
        <dt className="text-ink/55">Tokens</dt>
        <dd className="num">
          {r.inputTokens === null ? "–" : `${num(r.inputTokens)} in`} / {r.outputTokens === null ? "–" : `${num(r.outputTokens)} out`}
          {r.cacheReadTokens !== null && ` · cache ${num(r.cacheReadTokens)} read, ${num(r.cacheWriteTokens ?? 0)} written`}
        </dd>
        <dt className="text-ink/55">Job</dt>
        <dd>
          {r.jobId === null ? (
            "–"
          ) : (
            <Link to={`/pipeline/${r.jobId}`} className="num text-accent-ink hover:underline">
              Job {r.jobId}
            </Link>
          )}
        </dd>
        <dt className="text-ink/55">Items</dt>
        <dd>
          <Items r={r} max={8} expandable />
        </dd>
        {r.refusal && (
          <>
            <dt className="text-ink/55">{t("Refused")}</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <span>{r.refusal.outcome === "failed" ? t("by the model's safety filter; no other Task Runner or tier could take the call") : t("by the model's safety filter; retried")}</span>
              {r.refusal.retry && (
                <Link to={`/agents/${r.refusal.retry.id}${location.search}`} className="inline-flex items-center gap-1.5 text-accent-ink hover:underline max-md:min-h-11">
                  <span className="num">{t("Run {id}", { id: r.refusal.retry.id })}</span>
                  <Badge tone={STATE_TONE[r.refusal.retry.state]}>{t(STATE_LABEL[r.refusal.retry.state])}</Badge>
                </Link>
              )}
            </dd>
          </>
        )}
      </dl>
      {r.summary && <p className="rounded border border-line px-3 py-2 text-sm">{r.summary}</p>}
      {r.error && <p className="rounded border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">{r.error}</p>}
      {!r.textsHidden && (
        <>
          <Collapsible title="Prompt" text={r.prompt} empty="Prompt text removed after ten years." />
          <Collapsible title="Output" text={r.output} empty={r.state === "running" ? "Still running." : "Output removed after ten years."} open />
          <TranscriptLinks runId={r.id} transcripts={r.transcripts ?? []} off={!!r.transcriptsOff && !!r.via} />
        </>
      )}
    </div>
  );
}

export function DetailPanel({ params }: ViewProps) {
  const id = params.id ? Number(params.id) : null;
  const nav = useNavigate();
  if (id === null) return <div className="p-6 text-sm text-ink/50">Pick a run to see its prompt and output.</div>;
  return (
    <div className="h-full overflow-y-auto">
      <div className="flex h-10 items-center gap-2 border-b border-line px-4">
        <h2 className="num text-sm font-semibold">Run {id}</h2>
        <button onClick={() => nav(`/agents${location.search}`)} aria-label="Close" className="ml-auto text-ink/50 hover:text-ink">
          <XIcon />
        </button>
      </div>
      <RunDetailBody id={id} />
    </div>
  );
}

// ---- page ----------------------------------------------------------------------

export function AgentsView({ params }: ViewProps) {
  const id = params.id ? Number(params.id) : undefined;
  return (
    <Page title="Agents" sub="Model calls through the prompt registry">
      <RunsQueueSwitch value="runs" />
      <div className="mt-4 space-y-4">
        <RunningNow selected={id} />
        <RecentRuns selected={id} />
      </div>
    </Page>
  );
}

export function PhoneAgents(props: ViewProps) {
  const nav = useNavigate();
  const id = props.params.id ? Number(props.params.id) : null;
  return (
    <>
      <AgentsView {...props} />
      <Dialog.Root open={id !== null} onOpenChange={(o) => !o && nav(`/agents${location.search}`)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
          <Dialog.Content className="fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col rounded-t-lg border-t border-line bg-panel" aria-describedby={undefined}>
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
              <Dialog.Title className="num text-sm font-semibold">Run {id}</Dialog.Title>
              <Dialog.Close aria-label="Close" className="ml-auto flex size-11 items-center justify-center text-ink/60">
                <XIcon />
              </Dialog.Close>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">{id !== null && <RunDetailBody id={id} />}</div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

/** The model calls running now in a flowchart stage's steps (slot flow.panel). */
