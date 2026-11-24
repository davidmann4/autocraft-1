// Workspaces: the pods where a model session builds and runs code, and inside one the sessions and the log of its tool calls.
// Everything a pod or a model wrote is plain text; screenshots are images served by their own endpoint.
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AppWindowIcon, CameraIcon, CaretDownIcon, CaretRightIcon, CubeIcon, DownloadSimpleIcon, FileTextIcon, MagnifyingGlassIcon, PencilSimpleIcon, TerminalWindowIcon, type Icon } from "@phosphor-icons/react";
import { useApi, usePagedQuery, useQuery } from "../../api/client";
import type { WorkspaceCall, WorkspaceCallOutput, WorkspaceDetail, WorkspaceSession, WorkspaceState, WorkspaceSummary } from "../../api/types";
import type { ViewProps } from "../../registry/types";
import { nowMs, span, when } from "../../lib/format";
import { useNow } from "../../lib/useNow";
import { cn } from "../../ui/cn";
import { Badge, type Tone } from "../../ui/atoms/Badge";
import { Button } from "../../ui/atoms/Button";
import { EmptyState } from "../../ui/atoms/EmptyState";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { Block } from "../../ui/molecules/Block";
import { CodeBlock } from "../../ui/molecules/CodeBlock";
import { Facts } from "../../ui/molecules/Facts";
import { ItemRef } from "../../ui/molecules/ItemRef";
import { Segmented } from "../../ui/molecules/Segmented";
import { Page } from "../../ui/organisms/Page";
import { useUrlState } from "../../lib/hooks";

const STATE_TONE: Record<WorkspaceState, Tone> = { requested: "neutral", starting: "accent", seeding: "accent", ready: "ok", parked: "neutral", ended: "neutral", failed: "bad" };
const STATE_LABEL: Record<WorkspaceState, string> = { requested: "Requested", starting: "Starting", seeding: "Seeding", ready: "Ready", parked: "Parked", ended: "Ended", failed: "Failed" };
const SESSION_TONE: Record<WorkspaceSession["state"], Tone> = { queued: "neutral", starting: "accent", running: "accent", done: "ok", failed: "bad" };
const SESSION_LABEL: Record<WorkspaceSession["state"], string> = { queued: "Queued", starting: "Starting", running: "Running", done: "Done", failed: "Failed" };

const usd = (v: number | null) => (v === null ? null : `$${v.toFixed(2)}`);
const sha = (s: string) => s.slice(0, 8);

// ---- list -------------------------------------------------------------------------------------------

function WorkspaceRow({ w }: { w: WorkspaceSummary }) {
  const meta = [w.node, w.warm, usd(w.costUsd)].filter(Boolean);
  return (
    <li className="relative flex flex-col gap-1 px-4 py-3 hover:bg-ink/[0.03] max-md:py-3.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Link to={`/workspaces/${w.id}`} className="flex min-w-0 items-center gap-2 text-sm font-medium after:absolute after:inset-0">
          <CubeIcon className="shrink-0 text-ink/50" aria-hidden />
          <span className="code">{w.repo}</span>
          <span className="code text-ink/50">{sha(w.baseSha)}</span>
        </Link>
        <Badge tone={STATE_TONE[w.state]}>{STATE_LABEL[w.state]}</Badge>
        {w.app && <span className="code text-xs text-ink/55">{w.app}</span>}
        <span className="num ml-auto text-xs text-ink/55">
          <TimeAgo iso={w.createdAt} />
        </span>
      </div>
      {w.item !== null && <ItemRef repo={w.repo} number={w.item} title={null} size="sm" className="relative z-10 w-fit max-w-full" />}
      {meta.length > 0 && <p className="min-w-0 break-words text-xs text-ink/55 [overflow-wrap:anywhere]">{meta.join(" · ")}</p>}
    </li>
  );
}

function List() {
  const { state: f, update } = useUrlState();
  const which = f.show === "all" ? "all" : "live";
  const q = usePagedQuery(`workspaces:list:${which}`, (api, cursor) => api.workspaces.list({ state: which, cursor }), (p) => p.next);
  const rows = q.pages?.flatMap((p) => p.workspaces) ?? [];
  return (
    <Page title="Workspaces">
      <div className="mt-4 space-y-3">
        <Segmented label="Show" value={which} onChange={(v) => update({ show: v === "all" ? "all" : null })} options={[{ value: "live", label: "Live" }, { value: "all", label: "All" }]} />
        <ErrorLine error={q.error?.message} />
        <Block title="Workspaces" aside="newest first" flush>
          {rows.length > 0 && <ul className="divide-y divide-line">{rows.map((w) => <WorkspaceRow key={w.id} w={w} />)}</ul>}
          {!q.loading && rows.length === 0 && <EmptyState icon={CubeIcon}>{which === "live" ? "No workspace is live." : "No workspace yet."}</EmptyState>}
          {(q.hasMore || q.loadingMore) && (
            <div className="border-t border-line p-3">
              <Button size="sm" loading={q.loadingMore} onClick={q.loadMore} className="max-md:h-11">Load more</Button>
            </div>
          )}
        </Block>
      </div>
    </Page>
  );
}

// ---- detail -----------------------------------------------------------------------------------------

function SessionBlock({ s, canSee }: { s: WorkspaceSession; canSee: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="min-w-0 space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="num font-medium">Session {s.id}</span>
        <Badge tone={SESSION_TONE[s.state]}>{SESSION_LABEL[s.state]}</Badge>
        {s.kind && <span className="text-xs text-ink/55">{s.kind}</span>}
        <span className="num ml-auto text-xs text-ink/55">{[s.forLogin && `for ${s.forLogin}`, usd(s.costUsd), when(s.createdAt)].filter(Boolean).join(" · ")}</span>
      </div>
      <p className="text-xs text-ink/60">
        {s.jobId !== null && <>Job <Link to={`/pipeline/${s.jobId}`} className="code text-accent-ink hover:underline">{s.jobId}</Link>{s.outcome ? " · " : ""}</>}
        {s.outcome}
      </p>
      {canSee && s.prompt && (
        <div>
          <button onClick={() => setOpen(!open)} aria-expanded={open} className="inline-flex items-center gap-1 text-xs font-medium text-ink/70 hover:text-ink max-md:min-h-11">
            {open ? <CaretDownIcon aria-hidden /> : <CaretRightIcon aria-hidden />} Prompt
          </button>
          {open && <p className="mt-1 whitespace-pre-wrap break-words rounded border border-line bg-sunken p-3 text-xs [overflow-wrap:anywhere]">{s.prompt}</p>}
        </div>
      )}
      {s.reply && <CodeBlock title="Model reply" text={s.reply} lines={8} />}
    </li>
  );
}

const TOOL_ICON: Record<string, Icon> = {
  shell: TerminalWindowIcon, shell_status: TerminalWindowIcon, shell_kill: TerminalWindowIcon, read: FileTextIcon, write: PencilSimpleIcon, edit: PencilSimpleIcon,
  glob: MagnifyingGlassIcon, grep: MagnifyingGlassIcon, app_start: AppWindowIcon, app_stop: AppWindowIcon, screenshot: CameraIcon, fetch_dependencies: DownloadSimpleIcon,
};

function CallRow({ c, wsId, imageUrl }: { c: WorkspaceCall; wsId: number; imageUrl: (ws: number, call: number) => string }) {
  const running = c.state === "queued" || c.state === "running";
  const [open, setOpen] = useState(false);
  const ToolIcon = TOOL_ICON[c.tool] ?? TerminalWindowIcon;
  const ms = c.startedAt ? (c.finishedAt ? Date.parse(c.finishedAt) : nowMs()) - Date.parse(c.startedAt) : null;
  const canOpen = c.hasOutput || c.images > 0;
  const out = useQuery<WorkspaceCallOutput>(`workspace-output:${wsId}:${c.id}`, (a) => a.workspaces.output(wsId, c.id), { enabled: open && c.hasOutput });
  const bad = c.state === "failed" || c.isError;
  return (
    <li className="min-w-0">
      <button type="button" onClick={() => canOpen && setOpen(!open)} aria-expanded={canOpen ? open : undefined} className={cn("flex w-full min-w-0 items-start gap-2 px-4 py-2 text-left text-sm max-md:min-h-11", canOpen && "hover:bg-ink/[0.03]")}>
        <ToolIcon className="mt-0.5 shrink-0 text-ink/55" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="code text-xs font-medium">{c.tool}</span>
            {c.n !== null && <span className="num text-2xs text-ink/45">ws {c.n}</span>}
          </span>
          {c.summary && <span className={cn("code block break-words text-xs text-ink/70 [overflow-wrap:anywhere]", !open && "line-clamp-2")}>{c.summary}</span>}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          {running ? <Badge tone="accent">{c.state === "queued" ? "Queued" : "Running"}</Badge> : bad ? <Badge tone="bad">Failed</Badge> : null}
          {ms !== null && <span className="num text-xs text-ink/50">{span(Math.max(0, ms))}</span>}
        </span>
        {canOpen && (open ? <CaretDownIcon className="mt-1 shrink-0 text-ink/45" aria-hidden /> : <CaretRightIcon className="mt-1 shrink-0 text-ink/45" aria-hidden />)}
      </button>
      {c.images > 0 && c.notKept && (
        <p className="num mx-4 mb-2 ml-10 break-words text-xs text-ink/60 [overflow-wrap:anywhere]">
          Screenshot not kept ({c.notKept.bytes.toLocaleString("en")} bytes, sha256 <span className="code">{c.notKept.sha256.slice(0, 12)}</span>){c.notKept.note ? `: ${c.notKept.note}` : ""}
        </p>
      )}
      {c.images > 0 && !c.notKept && (
        <a href={imageUrl(wsId, c.id)} target="_blank" rel="noopener noreferrer" aria-label={`Open the screenshot of call ${c.id} full size`} className="mx-4 mb-2 ml-10 block w-fit max-w-full">
          <img src={imageUrl(wsId, c.id)} alt={`Screenshot of call ${c.id}`} loading="lazy" className={cn("rounded border border-line object-contain", open ? "max-h-[70vh]" : "max-h-40")} />
        </a>
      )}
      {open && c.hasOutput && (
        <div className="mx-4 mb-3 ml-10 min-w-0">
          {out.error ? <ErrorLine error={out.error.message} /> : out.data?.output != null ? (
            <>
              <pre className="code max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-sunken p-3 text-xs leading-relaxed [overflow-wrap:anywhere]">{out.data.output}</pre>
              {out.data.chars > out.data.output.length && <p className="num mt-1 text-2xs text-ink/50">{out.data.chars.toLocaleString("en")} characters, the middle left out</p>}
            </>
          ) : <p className="text-xs text-ink/50">{out.data ? "No output." : "Loading."}</p>}
        </div>
      )}
    </li>
  );
}

const active = (c: WorkspaceCall) => c.state === "running" || c.state === "queued";

/** The loaded calls live in a ref: a live refresh asks only for calls past the last one and for those still running, and merges them. */
function Calls({ w }: { w: WorkspaceDetail }) {
  const api = useApi();
  const store = useRef<{ rows: WorkspaceCall[]; older: string | null; ready: boolean }>({ rows: [], older: null, ready: false });
  const [, redraw] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string>();
  const merge = (rows: WorkspaceCall[]) => {
    const byId = new Map(store.current.rows.map((c) => [c.id, c]));
    for (const c of rows) byId.set(c.id, c);
    store.current.rows = [...byId.values()].sort((a, b) => a.id - b.id);
  };
  const q = useQuery(`workspaces:calls:${w.id}`, async (a) => {
    const s = store.current;
    if (!s.ready) {
      const r = await a.workspaces.calls(w.id);
      s.rows = r.calls;
      s.older = r.older;
      s.ready = true;
    } else {
      merge((await a.workspaces.calls(w.id, { after: s.rows[s.rows.length - 1]?.id ?? 0, running: s.rows.filter(active).map((c) => c.id).slice(0, 50) })).calls);
    }
    return [...s.rows];
  });
  const rows = q.data ?? [];
  useNow(rows.some(active) ? 1000 : undefined);
  const older = store.current.older;
  const loadOlder = async () => {
    setLoadingOlder(true);
    setOlderError(undefined);
    try {
      const r = await api.workspaces.calls(w.id, { before: older ?? undefined });
      merge(r.calls);
      store.current.older = r.older;
      redraw((n) => n + 1);
    } catch (e) {
      setOlderError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingOlder(false);
    }
  };
  return (
    <Block title={<>Calls {q.data && <span className="num ml-1 font-normal text-ink/50">{rows.length}{older ? "+" : ""}</span>}</>} aside="oldest first" flush>
      <ErrorLine error={q.error?.message ?? olderError} className="p-4" />
      {older && (
        <div className="border-b border-line p-3">
          <Button size="sm" loading={loadingOlder} onClick={() => void loadOlder()} className="max-md:h-11">Load earlier calls</Button>
        </div>
      )}
      {rows.length > 0 && <ul className="divide-y divide-line">{rows.map((c) => <CallRow key={c.id} c={c} wsId={w.id} imageUrl={api.workspaces.imageUrl} />)}</ul>}
      {!q.loading && rows.length === 0 && !q.error && <EmptyState icon={TerminalWindowIcon}>No call yet.</EmptyState>}
    </Block>
  );
}

function Detail({ id }: { id: number }) {
  const q = useQuery<WorkspaceDetail>(`workspace:${id}`, (a) => a.workspaces.get(id));
  const w = q.data;
  return (
    <Page title={`Workspace ${id}`} sub={w && <><span className="code">{w.repo}</span> <span className="code">{sha(w.baseSha)}</span></>}>
      <Link to="/workspaces" className="mt-1 inline-flex items-center text-xs text-accent-ink hover:underline max-md:min-h-11">All workspaces</Link>
      <ErrorLine error={q.error?.message} />
      {w && (
        <div className="mt-3 space-y-4">
          <Block title="Workspace" aside={<Badge tone={STATE_TONE[w.state]}>{STATE_LABEL[w.state]}</Badge>}>
            <Facts
              rows={[
                ["Repository", <span className="code" key="r">{w.repo}</span>],
                ["Commit", <span className="code" key="c">{w.baseSha}</span>],
                ["Item", w.item !== null && <ItemRef key="i" repo={w.repo} number={w.item} title={null} size="sm" />],
                ["App", w.app && <span className="code" key="a">{w.app}</span>],
                [STATE_LABEL[w.state], <span key="s">since <TimeAgo iso={w.stateAt} /></span>],
                ["Created", when(w.createdAt)],
                ["Ended", w.endedAt && when(w.endedAt)],
                ["Environment", w.env && <span className="code" key="e">{w.env}</span>],
                ["Node", w.node && <span className="code" key="n">{w.node}</span>],
                ["Warm start", w.warm],
                ["Cost", usd(w.costUsd)],
                ["Error", w.error && <span className="text-bad" key="x">{w.error}</span>],
              ]}
            />
          </Block>
          {w.canSee && (
            <Block title={<>Sessions <span className="num ml-1 font-normal text-ink/50">{w.sessionList.length}</span></>} flush>
              {w.sessionList.length > 0 ? <ul className="divide-y divide-line">{w.sessionList.map((s) => <SessionBlock key={s.id} s={s} canSee={w.canSee} />)}</ul> : <EmptyState icon={CubeIcon}>No session has run here.</EmptyState>}
            </Block>
          )}
          {w.canSee && <Calls key={w.id} w={w} />}
        </div>
      )}
    </Page>
  );
}

export function WorkspacesView({ params }: ViewProps) {
  return params.id && /^\d+$/.test(params.id) ? <Detail id={Number(params.id)} /> : <List />;
}
