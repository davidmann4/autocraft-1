// The Live board at the top of Home: every running and queued unit of the pipeline's work on one time axis. A lane is a job (or a call or
// build task of its own); its thin bar is the job, the tall bars are its model calls and build steps. Solid: done, pulsing: running now,
// dashed: the expected rest (median of earlier runs), red line: 90% of earlier runs were done by then. Staff can switch to the worker
// view: one row per Task Runner (private ones share one) or Jev, with the model calls each ran, coloured by step and marked with their item.
import { useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "../../../api/client";
import type { LiveEstimate, LiveLane, LiveOp, LiveOpKind, LiveWorker } from "../../../api/types";
import { useUrlState } from "../../../lib/hooks";
import { Avatar } from "../../../ui/atoms/Avatar";
import { compact } from "../../../ui/molecules/BarList";
import { Segmented } from "../../../ui/molecules/Segmented";
import { nowMs } from "../../../lib/format";
import { itemPath } from "../../../lib/links";
import { useNow } from "../../../lib/useNow";
import { cn } from "../../../ui/cn";
import { ItemIcon } from "../../../ui/atoms/ItemIcon";
import { TipLines, Tooltip } from "../../../ui/atoms/Tooltip";
import { ItemPeek } from "../../../ui/molecules/ItemPeek";
import { Section } from "../../../ui/molecules/Section";
import { ErrorLine } from "../../admin/parts";

const KIND: Record<LiveOpKind | "job", { label: string; bg: string; border: string }> = {
  model: { label: "Model call", bg: "bg-accent", border: "border-accent" },
  setup: { label: "Setup", bg: "bg-c4", border: "border-c4" },
  build: { label: "Build", bg: "bg-warn", border: "border-warn" },
  tests: { label: "Tests", bg: "bg-ok", border: "border-ok" },
  lint: { label: "Lint", bg: "bg-c3", border: "border-c3" },
  other: { label: "Other step", bg: "bg-c5", border: "border-c5" },
  job: { label: "Job", bg: "bg-ink/30", border: "border-ink/40" },
};
const LEGEND: (LiveOpKind | "job")[] = ["model", "setup", "build", "tests", "lint", "other", "job"];

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** Where running work is against its estimate. */
function eta(start: number, e: LiveEstimate | null, now: number): { text: string; late: boolean } {
  const elapsed = now - start;
  if (!e) return { text: fmtDur(elapsed), late: false };
  const left = e.median - elapsed;
  if (left > 0) return { text: `${fmtDur(elapsed)} · ~${fmtDur(left)} left`, late: false };
  return elapsed > e.p90 ? { text: `${fmtDur(elapsed)} · longer than 90% of earlier runs`, late: true } : { text: `${fmtDur(elapsed)} · should be done any moment`, late: false };
}

/** The tip on a bar: what it is, when, and against what it usually takes. */
function BarTip({ detail, start, end, estimate, now, failed }: { detail?: string | null; start: number; end: number | null; estimate: LiveEstimate | null; now: number; failed?: boolean }) {
  const running = end === null;
  const r = running ? eta(start, estimate, now) : null;
  return (
    <TipLines
      lines={[
        detail,
        `${clock(start)} – ${running ? "now" : clock(end)} · ${fmtDur((end ?? now) - start)}${failed ? " · failed" : ""}`,
        r && <span className={r.late ? "text-bad" : undefined}>{r.text}</span>,
        estimate && `Usually ${fmtDur(estimate.median)}, 90% within ${fmtDur(estimate.p90)} (${estimate.samples} runs)`,
      ]}
    />
  );
}

/** One lane's track: the job as a thin bar, its calls and steps as tall ones, and the expected rest of what runs. */
function Track({ lane, from, to, now }: { lane: LiveLane; from: number; to: number; now: number }) {
  const x = (t: number) => `${((Math.min(Math.max(t, from), to) - from) / (to - from)) * 100}%`;
  const w = (a: number, b: number) => `${(Math.max(0, Math.min(b, to) - Math.max(a, from)) / (to - from)) * 100}%`;
  const start = Date.parse(lane.start);
  const end = lane.end ? Date.parse(lane.end) : now;
  const ghost = (s: number, e: LiveEstimate | null, kind: LiveOpKind | "job", thin: boolean) => {
    if (!e) return null;
    const due = s + e.median;
    const late = s + e.p90;
    return (
      <>
        {due > now && <div aria-hidden className={cn("absolute rounded-sm border border-dashed", KIND[kind].border, thin ? "top-[18px] h-1.5" : "top-1 h-3.5")} style={{ left: x(now), width: w(now, due) }} />}
        {late > now && <div aria-hidden className="absolute top-0 h-6 w-px bg-bad/60" style={{ left: x(late) }} />}
      </>
    );
  };
  const running = lane.state === "running";
  return (
    <div className="relative h-6 rounded bg-ink/[0.04]">
      {lane.state !== "queued" && (
        <Tooltip title={lane.title} content={<BarTip detail={lane.line} start={start} end={lane.end ? end : null} estimate={lane.estimate} now={now} failed={lane.state === "failed"} />}>
          <div className={cn("absolute top-[18px] h-1.5 rounded-sm", lane.state === "failed" ? "bg-bad/70" : KIND.job.bg)} style={{ left: x(start), width: w(start, end), minWidth: 2 }} />
        </Tooltip>
      )}
      {running && ghost(start, lane.estimate, "job", true)}
      {lane.ops.map((o: LiveOp, i) => {
        const s = Date.parse(o.start);
        const e = o.end ? Date.parse(o.end) : now;
        if (e < from) return null;
        return (
          <span key={i}>
            <Tooltip title={`${KIND[o.kind].label}: ${o.label}`} content={<BarTip detail={o.detail} start={s} end={o.end ? e : null} estimate={o.estimate} now={now} failed={o.failed} />}>
              <div
                className={cn("absolute top-1 h-3.5 rounded-sm", o.failed ? "bg-bad" : KIND[o.kind].bg, o.end === null ? "animate-pulse" : "opacity-70")}
                style={{ left: x(s), width: w(s, e), minWidth: 3 }}
              />
            </Tooltip>
            {o.end === null && ghost(s, o.estimate, o.kind, false)}
          </span>
        );
      })}
      <div aria-hidden className="pointer-events-none absolute -top-1 h-8 w-px bg-ink/70" style={{ left: x(now) }} />
    </div>
  );
}

const DOT: Record<LiveLane["state"], string> = { running: "animate-pulse bg-ok", queued: "bg-warn", done: "bg-ink/30", failed: "bg-bad" };

function LaneInfo({ lane, now }: { lane: LiveLane; now: number }) {
  const r = lane.state === "running" ? eta(Date.parse(lane.start), lane.estimate, now) : null;
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <span className={cn("size-2 shrink-0 rounded-full", DOT[lane.state])} aria-hidden />
        <Link to={lane.detail} className="truncate text-sm font-medium hover:underline">
          {lane.title}
        </Link>
        {r && <span className={cn("num ml-auto shrink-0 text-2xs", r.late ? "text-bad" : "text-ink/50")}>{r.text}</span>}
        {lane.state === "queued" && <span className="ml-auto shrink-0 text-2xs text-ink/50">queued</span>}
        {(lane.state === "done" || lane.state === "failed") && lane.end && <span className="ml-auto shrink-0 text-2xs text-ink/45">ended {fmtDur(now - Date.parse(lane.end))} ago</span>}
      </div>
      {lane.item && (
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 pl-4 text-xs text-ink/60">
          <ItemIcon kind={lane.item.kind} state={lane.item.state} />
          <ItemPeek repo={lane.item.repo} number={lane.item.number}>
            <Link to={itemPath(lane.item.repo, lane.item.number)} className="code shrink-0 text-accent-ink hover:underline">
              #{lane.item.number}
            </Link>
          </ItemPeek>
          <span className="truncate">{lane.item.title}</span>
          {lane.itemCount > 1 && <span className="shrink-0 text-ink/45">+{lane.itemCount - 1}</span>}
        </div>
      )}
      {lane.line && <div className={cn("mt-0.5 truncate pl-4 text-2xs", lane.state === "failed" ? "text-bad" : "text-ink/50")}>{lane.line}</div>}
    </div>
  );
}

/** Ended lanes the server no longer sends that stay on the board at most; past this the oldest go. */
const GONE_MAX = 12;

/**
 * The lanes in the order they first arrived, so a lane never changes place when its job starts or ends. A lane the server stops sending
 * (an ended job that touched no item, or one past the board's time window) stays in its place as ended until the reader comes back to the
 * tab or the page loads again.
 */
function useSteadyLanes(lanes: LiveLane[] | undefined): LiveLane[] {
  const kept = useRef(new Map<string, LiveLane>());
  const latest = useRef(new Set<string>());
  const [pruned, prune] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const back = () => {
      if (document.visibilityState !== "visible") return;
      for (const k of kept.current.keys()) if (!latest.current.has(k)) kept.current.delete(k);
      prune();
    };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, []);
  return useMemo(() => {
    const map = kept.current;
    if (lanes) {
      const seen = new Set(lanes.map((l) => l.key));
      latest.current = seen;
      const at = new Date(nowMs()).toISOString();
      for (const [k, l] of map) {
        if (seen.has(k) || (l.state !== "running" && l.state !== "queued")) continue;
        map.set(k, { ...l, state: "done", start: l.state === "queued" ? at : l.start, end: at, estimate: null, ops: l.ops.map((o) => (o.end ? o : { ...o, end: at, estimate: null })) });
      }
      // Map.set keeps an existing key's place; new lanes go to the end.
      for (const l of lanes) map.set(l.key, l);
      const gone = [...map.keys()].filter((k) => !seen.has(k));
      for (const k of gone.slice(0, Math.max(0, gone.length - GONE_MAX))) map.delete(k);
    }
    return [...map.values()];
    // `pruned` re-reads the map after a prune.
  }, [lanes, pruned]);
}

type StepGroup = "review" | "fix" | "triage" | "act" | "security" | "other";

/** Each step's colour on the worker view, fixed by the step's group; the chart slots pass the colour-vision and 3:1 checks. */
const STEP_GROUP: Record<StepGroup, { label: string; bg: string }> = {
  review: { label: "Review and verify", bg: "bg-c1" },
  fix: { label: "Fixes", bg: "bg-c3" },
  triage: { label: "Triage", bg: "bg-c2" },
  act: { label: "Commands and merges", bg: "bg-c4" },
  security: { label: "Security", bg: "bg-c5" },
  other: { label: "Other steps", bg: "bg-ink/50" },
};
const STEP_GROUPS = Object.keys(STEP_GROUP) as StepGroup[];

const stepGroup = (step: string): StepGroup =>
  step.startsWith("security") ? "security"
    : /^(implement|fixissue|fixup|cifix|main-?fix|conflict|fix-)/.test(step) ? "fix"
    : /review|^verify|^premerge|^postmerge|^referee/.test(step) ? "review"
    : /^(classify|dupes|prioritize|rank|areas|labels|details|embed)/.test(step) ? "triage"
    : /^(workflow|merge|act$|conversation|close|unassign)/.test(step) ? "act"
    : "other";

const STATUS: Record<LiveWorker["status"], { dot: string; label: string }> = {
  online: { dot: "bg-ok", label: "online" },
  held: { dot: "bg-warn", label: "not taking calls" },
  offline: { dot: "bg-ink/30", label: "offline" },
};

/** A worker row's left side: who it is, whose tokens, whether it takes calls, how many it runs of its slots and the models it offers. */
function WorkerInfo({ w }: { w: LiveWorker }) {
  const sub = w.kind === "runner" ? [w.login && `@${w.login}`, w.harness, STATUS[w.status].label] : [];
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        {w.login ? <Avatar login={w.login} size={16} /> : <span className={cn("size-2 shrink-0 rounded-full", STATUS[w.status].dot)} aria-hidden />}
        <span className="truncate text-sm font-medium">{w.name}</span>
        <span className="num ml-auto shrink-0 text-2xs text-ink/60">
          {w.busy}
          {w.slots !== null && ` of ${w.slots}`} busy
        </span>
      </div>
      {sub.length > 0 && (
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 pl-6 text-2xs text-ink/60">
          {w.login && <span className={cn("size-1.5 shrink-0 rounded-full", STATUS[w.status].dot)} aria-hidden />}
          <span className="truncate">{sub.filter(Boolean).join(" · ")}</span>
        </div>
      )}
      {w.models.length > 0 && <div className="mt-0.5 truncate pl-6 text-2xs text-ink/60">{w.models.join(", ")}</div>}
      {w.note && <div className={cn("mt-0.5 truncate pl-6 text-2xs", w.status === "held" ? "text-warn" : "text-ink/60")}>{w.note}</div>}
    </div>
  );
}

/**
 * A worker's track: one bar per model call, coloured by step, with its item's number on it; a running call pulses and shows its
 * expected rest. The track is one tab stop: arrow keys, Home and End move focus between its calls.
 */
function WorkerTrack({ w, from, to, now }: { w: LiveWorker; from: number; to: number; now: number }) {
  const x = (t: number) => `${((Math.min(Math.max(t, from), to) - from) / (to - from)) * 100}%`;
  const wd = (a: number, b: number) => `${(Math.max(0, Math.min(b, to) - Math.max(a, from)) / (to - from)) * 100}%`;
  const calls = w.calls.filter((c) => (c.end ? Date.parse(c.end) : now) >= from);
  const refs = useRef(new Map<number, HTMLAnchorElement>());
  const [active, setActive] = useState<number | null>(null);
  // The tab stop: the call last focused, or the newest.
  const stop = calls.some((c) => c.id === active) ? active : (calls.at(-1)?.id ?? null);
  const onKey = (e: KeyboardEvent<HTMLAnchorElement>, i: number) => {
    const j = e.key === "ArrowRight" || e.key === "ArrowDown" ? i + 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? calls.length - 1 : null;
    if (j === null) return;
    e.preventDefault();
    const c = calls[Math.max(0, Math.min(calls.length - 1, j))]!;
    setActive(c.id);
    refs.current.get(c.id)?.focus();
  };
  return (
    <div role="group" aria-label={`${w.name}: ${calls.length === 1 ? "1 model call" : `${calls.length} model calls`}`} className="relative h-7 rounded bg-ink/5">
      {calls.map((c, i) => {
        const s = Date.parse(c.start);
        const e = c.end ? Date.parse(c.end) : now;
        const what = c.item ? `${c.item.repo}#${c.item.number}${c.itemCount > 1 ? ` and ${c.itemCount - 1} more` : ""}` : null;
        const due = c.estimate && c.end === null ? s + c.estimate.median : null;
        // The item's number shows on bars wide enough to hold it; a narrower one has it in its name and tip.
        const roomy = (Math.min(e, to) - Math.max(s, from)) / (to - from) > 0.045;
        const tag = c.item ? `#${c.item.number}` : null;
        return (
          <span key={c.id}>
            <Tooltip
              title={`${c.title}${what ? `: ${what}` : ""}`}
              content={
                <TipLines
                  lines={[
                    c.item?.title,
                    `${c.model}${c.tokens !== null ? ` · ${compact(c.tokens)} tokens` : ""}`,
                    <BarTip key="t" start={s} end={c.end ? e : null} estimate={c.estimate} now={now} failed={c.failed} />,
                  ]}
                />
              }
            >
              <Link
                ref={(el) => {
                  if (el) refs.current.set(c.id, el);
                  else refs.current.delete(c.id);
                }}
                to={`/agents/${c.id}`}
                tabIndex={c.id === stop ? 0 : -1}
                onFocus={() => setActive(c.id)}
                onKeyDown={(ev) => onKey(ev, i)}
                aria-label={`${roomy && tag ? `${tag} ` : ""}${c.title}${what ? ` on ${what}` : ""}, ${c.end ? `took ${fmtDur(e - s)}${c.failed ? ", failed" : ""}` : `running for ${fmtDur(now - s)}`}`}
                className="group absolute top-0.5 flex h-6 min-w-1 items-center overflow-hidden rounded-sm px-0.5 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ink"
                style={{ left: x(s), width: wd(s, e) }}
              >
                {/* Only the fill pulses, so the number keeps its contrast; ink on the panel colour reads on every step colour. */}
                <span aria-hidden className={cn("absolute inset-0", c.failed ? "bg-bad" : STEP_GROUP[stepGroup(c.step)].bg, c.end === null && "animate-pulse")} />
                {roomy && tag && <span className="num relative truncate rounded-sm bg-panel px-1 text-2xs font-medium leading-4 text-ink">{tag}</span>}
              </Link>
            </Tooltip>
            {due !== null && due > now && <div aria-hidden className="absolute top-0.5 h-6 rounded-sm border border-dashed border-ink/40" style={{ left: x(now), width: wd(now, due) }} />}
          </span>
        );
      })}
      <div aria-hidden className="pointer-events-none absolute -top-1 h-9 w-px bg-ink/70" style={{ left: x(now) }} />
    </div>
  );
}

type LiveView = "jobs" | "workers";

/** The Live board: lanes of running, queued and lately ended work over the last hour and what is expected next, then the latest events. */
export function LiveBoard() {
  const { data, error } = useQuery("live", (a) => a.live());
  const { state: url, update: setUrl } = useUrlState();
  useNow(1000);
  const now = nowMs();
  const lanes = useSteadyLanes(data?.lanes);
  const workers = data?.workers;
  const view: LiveView = workers && url.live === "workers" ? "workers" : "jobs";
  const running = lanes.filter((l) => l.state === "running");
  // Axis: the last hour (less when nothing is that old), up to the latest expected end.
  const lateBy = (start: string, e: LiveEstimate | null) => (e ? Date.parse(start) + e.p90 : now);
  const calls = view === "workers" ? (workers ?? []).flatMap((w) => w.calls) : [];
  const starts = view === "workers" ? calls.map((c) => Date.parse(c.start)) : lanes.filter((l) => l.state !== "queued").map((l) => Date.parse(l.start));
  const ends = view === "workers"
    ? calls.filter((c) => !c.end).map((c) => lateBy(c.start, c.estimate))
    : running.flatMap((l) => [lateBy(l.start, l.estimate), ...l.ops.filter((o) => !o.end).map((o) => lateBy(o.start, o.estimate))]);
  const from = Math.max(now - 60 * 60_000, Math.min(now - 10 * 60_000, ...starts));
  const to2 = Math.min(now + 60 * 60_000, Math.max(now + 5 * 60_000, ...ends) + 60_000);
  const step = to2 - from > 50 * 60_000 ? 15 * 60_000 : 5 * 60_000;
  const ticks: number[] = [];
  // A tick too close to "now" would sit under its label.
  for (let t = Math.ceil(from / step) * step; t < to2; t += step) if (Math.abs(t - now) > (to2 - from) * 0.04) ticks.push(t);
  const pct = (t: number) => `${((t - from) / (to2 - from)) * 100}%`;
  const groups = new Set(calls.map((c) => stepGroup(c.step)));
  const legend = STEP_GROUPS.filter((g) => groups.has(g));
  const switcher = workers && (
    <Segmented
      label="Show the Live board"
      className="ml-auto"
      value={view}
      options={[{ value: "jobs", label: "By job" }, { value: "workers", label: "By worker" }]}
      onChange={(v) => setUrl({ live: v === "workers" ? "workers" : null })}
    />
  );
  const axis = (
    <>
      <div className="border-b border-line max-md:hidden" />
      <div className="relative h-6 border-b border-line max-md:hidden">
        {ticks.map((t) => (
          <span key={t} className="num absolute top-1 -translate-x-1/2 text-2xs text-ink/45" style={{ left: pct(t) }}>
            {clock(t)}
          </span>
        ))}
        <span className="absolute top-1 -translate-x-1/2 text-2xs font-semibold text-ink" style={{ left: pct(now) }}>
          now
        </span>
      </div>
    </>
  );
  return (
    <Section
      title={
        <span className="inline-flex items-center gap-2">
          <span className="relative flex size-2" aria-hidden>
            {running.length > 0 && <span className="absolute inline-flex size-full animate-ping rounded-full bg-ok opacity-60" />}
            <span className={cn("relative inline-flex size-2 rounded-full", running.length > 0 ? "bg-ok" : "bg-ink/30")} />
          </span>
          Live
          {running.length > 0 && <span className="text-xs font-normal text-ink/55">{running.length} running</span>}
        </span>
      }
      to="/activity"
      linkLabel="All activity"
    >
      <ErrorLine error={error?.message} />
      {view === "workers" && workers && (
        <div className="overflow-hidden rounded-md border border-line">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-ink/[0.03] px-3 py-1.5 text-2xs text-ink/55">
            {legend.map((g) => (
              <span key={g} className="inline-flex items-center gap-1.5">
                <span className={cn("h-2 w-3 rounded-sm", STEP_GROUP[g].bg)} aria-hidden />
                {STEP_GROUP[g].label}
              </span>
            ))}
            {legend.length === 0 && <span>No model calls in the last hour</span>}
            {switcher}
          </div>
          {workers.length === 0 ? (
            <p className="px-3 py-3 text-sm text-ink/55">No Task Runner is online, and none ran a call in the last hour.</p>
          ) : (
            <div className="grid grid-cols-[minmax(0,1fr)] md:grid-cols-[minmax(15rem,22rem)_minmax(0,1fr)]">
              {axis}
              {workers.map((w) => (
                <div key={w.key} className="contents">
                  <div className="px-3 py-2 md:border-b md:border-line">
                    <WorkerInfo w={w} />
                  </div>
                  <div className="flex flex-col justify-center border-b border-line px-3 py-2 max-md:pt-0">
                    <WorkerTrack w={w} from={from} to={to2} now={now} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {view === "jobs" && data && lanes.length === 0 && (
        <div className="flex items-center gap-2 border-t border-line py-3 text-sm text-ink/55">
          Nothing is running or queued.
          {switcher}
        </div>
      )}
      {view === "jobs" && lanes.length > 0 && (
        <div className="overflow-hidden rounded-md border border-line">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-ink/[0.03] px-3 py-1.5 text-2xs text-ink/55">
            {LEGEND.map((k) => (
              <span key={k} className="inline-flex items-center gap-1.5">
                <span className={cn("rounded-sm", KIND[k].bg, k === "job" ? "h-1.5 w-3" : "h-2 w-3")} aria-hidden />
                {KIND[k].label}
              </span>
            ))}
            {switcher}
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)] md:grid-cols-[minmax(15rem,22rem)_minmax(0,1fr)]">
            {axis}
            {lanes.map((l) => (
              <div key={l.key} className={cn("contents", l.state !== "running" && l.state !== "queued" && "[&>*]:opacity-60")}>
                <div className="px-3 py-2 md:border-b md:border-line">
                  <LaneInfo lane={l} now={now} />
                </div>
                <div className="flex flex-col justify-center border-b border-line px-3 py-2 max-md:pt-0">
                  <Track lane={l} from={from} to={to2} now={now} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}
