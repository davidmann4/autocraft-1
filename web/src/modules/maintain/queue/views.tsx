// Work queue: running now, waiting with the reason, the merge queue (batches, next merges, hold), the held items, the model call
// queue and recently merged. Every list updates in place from the live topics.
import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { t } from "../../../../../src/i18n/index.ts";
import { useApi, useQuery } from "../../../api/client";
import { usePageProject } from "../../../api/scope";
import type { ItemKind, ItemState, LiveBoard, MaintainQueueMeta, ModelQueue, NextMerge, QueueBatch, StageTrip } from "../../../api/types";
import { batchPath } from "../../../lib/links";
import { clock, nowMs } from "../../../lib/format";
import { useNow } from "../../../lib/useNow";
import { useWrite } from "../../../lib/hooks";
import { canRun } from "../../../registry/permissions";
import type { ViewProps } from "../../../registry/types";
import { useUser } from "../../../shell/UserContext";
import { Button } from "../../../ui/atoms/Button";
import { ErrorLine } from "../../../ui/atoms/ErrorLine";
import { Pending } from "../../../ui/atoms/Pending";
import { ItemRef } from "../../../ui/molecules/ItemRef";
import { PENDING_STEP } from "../../queue/pendingStep";
import { BATCH_STATE } from "../../queue/mergeParts";
import { QueueRow as ModelCallRow } from "../../agents/queue";
import { WarningIcon } from "@phosphor-icons/react";
import { ConfirmButton } from "../../admin/parts";
import { RecentlyMerged } from "../../queue/RecentlyMerged";
import { usePage } from "../../queue/usePage";

function Part({ title, count, empty, children, aside }: { title: string; count: number; empty: string; children?: ReactNode; aside?: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <div className="mt-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink/70">
          {title} <span className="num font-normal">({count})</span>
        </h2>
        {aside}
      </div>
      {count ? <ul className="divide-y divide-line rounded-lg border border-line bg-panel">{children}</ul> : <p className="rounded-lg border border-line px-3 py-3 text-sm text-ink/70">{empty}</p>}
    </section>
  );
}

function Row({ item, line, action }: { item: { repo: string; number: number; kind?: ItemKind | null; state?: ItemState | null; title: string | null }; line: ReactNode; action?: ReactNode }) {
  return (
    <li className="relative flex items-start gap-3 px-3 py-2.5 hover:bg-ink/[0.025]">
      <div className="min-w-0 flex-1">
        <ItemRef repo={item.repo} number={item.number} kind={item.kind} state={item.state} title={item.title} stretch />
        <p className="mt-0.5 text-sm text-ink/80">{line}</p>
      </div>
      {action && <div className="relative z-10 shrink-0">{action}</div>}
    </li>
  );
}

/** Small secondary button; the touch target grows past its box with a transparent overlay, not with its size. */
const small = "relative h-8 after:absolute after:-inset-x-2 after:-inset-y-2";

/** Holds an item, or resumes a held one, by the command of that name. */
function HoldButton({ m, held }: { m: Pick<NextMerge, "repo" | "number">; held?: boolean }) {
  const api = useApi();
  const write = useWrite();
  if (!canRun(useUser(), m.repo)) return null;
  const word = held ? "resume" : "hold";
  const go = async () => {
    const r = await api.maintainItem.command(m.repo, m.number, word);
    if (!r.ok) throw new Error(r.lines.join(" "));
  };
  return (
    <span className="flex flex-col items-end gap-1">
      <Button size="sm" className={small} aria-label={t("{word} {ref}", { word: held ? t("Resume") : t("Hold"), ref: key(m) })} loading={write.busy === word} onClick={() => void write.run(word, go)}>
        {held ? t("Resume") : t("Hold")}
      </Button>
      <ErrorLine error={write.error} className="text-2xs" />
    </span>
  );
}

function StopBatch({ b }: { b: QueueBatch }) {
  const api = useApi();
  const write = useWrite();
  if (!canRun(useUser(), b.repo)) return null;
  return (
    <span className="flex flex-col items-end gap-1">
      <ConfirmButton idle="secondary" label={t("Stop batch")} confirmLabel={t("Confirm stop batch")} loading={write.busy === "stop"} onConfirm={() => void write.run("stop", () => api.queueControl.stopBatch(b.id))} />
      <ErrorLine error={write.error} className="text-2xs" />
    </span>
  );
}

const key = (r: { repo: string; number: number }) => `${r.repo}#${r.number}`;

function approval(meta: MaintainQueueMeta, r: { repo: string; number: number }): string | null {
  const by = meta.approvedBy[key(r)];
  return by ? t("Approved by {login}", { login: by }) : null;
}

/** "Batch 14 in CI since 10:12: <what it does now>", from the batch's live lane when it has one. */
function batchLine(b: QueueBatch, live: LiveBoard | undefined): string {
  const lane = live?.lanes.find((l) => l.key === `batch:${b.id}` && l.state === "running");
  if (!lane) return t("Batch {id} · {state}", { id: b.id, state: BATCH_STATE[b.state][0] });
  return t("Batch {id} in CI since {at}: {line}", { id: b.id, at: clock(lane.start), line: lane.line ?? lane.title });
}

function MergeQueue({ project, meta }: { project: string | null; meta: MaintainQueueMeta }) {
  const { pages, error } = usePage("merge", project ?? "pipeline", undefined);
  const live = useQuery("live", (a) => a.live()).data;
  const first = pages?.[0];
  if (!first) return <Pending error={error} />;
  const next = first.nextMerges;
  const batchKeys = new Set(first.batches.flatMap((b) => b.prs.map(key)));
  const inLine = next.filter((m) => !batchKeys.has(key(m)));
  const queued = first.pending ?? [];
  const lineOf = (r: { repo: string; number: number }, text: ReactNode) => {
    const a = approval(meta, r);
    return a ? <>{a} · {text}</> : text;
  };
  return (
    <section aria-label={t("Merge queue")} className="flex flex-col gap-1">
      <h2 className="mt-2 text-sm font-semibold text-ink/70">{t("Merge queue")}</h2>
      <div className="divide-y divide-line rounded-lg border border-line bg-panel">
        {first.batches.map((b) => (
          <div key={b.id}>
            <div className="flex items-start gap-3 px-3 py-2.5 text-sm">
              <p className="min-w-0 flex-1">
                <Link to={batchPath(b.id)} className="font-semibold text-accent-ink hover:underline">
                  {batchLine(b, live)}
                </Link>{" "}
                <span className="text-ink/70">
                  · {b.repo} · {b.size === 1 ? t("1 PR") : t("{n} PRs", { n: b.size })}
                </span>
              </p>
              <StopBatch b={b} />
            </div>
            <ul className="divide-y divide-line border-t border-line">
              {b.prs.map((r) => (
                <Row key={key(r)} item={{ ...r, kind: "pr" as const, state: "open" as const }} line={lineOf(r, t("Merges with the batch when CI is green"))} action={<HoldButton m={r} />} />
              ))}
            </ul>
          </div>
        ))}
        <p className="px-3 pt-2 text-sm font-semibold">
          {t("Next merges")} <span className="num font-normal text-ink/70">({inLine.length})</span>
        </p>
        {inLine.length ? (
          <ul className="divide-y divide-line">
            {inLine.map((m, i) => (
              <Row key={key(m)} item={{ ...m, kind: "pr" as const, state: "open" as const }} line={<><span className="num mr-1.5 text-ink/60">{i + 1}.</span>{lineOf(m, m.label)}</>} action={<HoldButton m={m} />} />
            ))}
          </ul>
        ) : (
          <p className="px-3 pb-2 text-sm text-ink/70">{t("Nothing in line.")}</p>
        )}
        {queued.length > 0 && (
          <>
            <p className="px-3 pt-2 text-sm font-semibold">
              {t("Queued, not reviewed yet")} <span className="num font-normal text-ink/70">({queued.length})</span>
            </p>
            <ul className="divide-y divide-line">
              {queued.map((r) => (
                <Row key={key(r)} item={{ ...r, kind: r.kind, state: "open" as const }} line={lineOf(r, r.implement ? `${r.implement.text}${r.implement.wait ? ` · ${r.implement.wait}` : ""}` : r.next ?? (r.step === "next" || r.step === "implement" ? t("In progress") : t(PENDING_STEP[r.step])))} action={<HoldButton m={r} />} />
              ))}
            </ul>
          </>
        )}
        <details className="px-3 py-1 text-sm">
          <summary className="flex h-11 cursor-pointer items-center font-semibold">{t("Merged recently")}</summary>
          <RecentlyMerged repo={project} />
        </details>
      </div>
      <ErrorLine error={error?.message} />
    </section>
  );
}

function HeldItems({ project, meta }: { project: string | null; meta: MaintainQueueMeta }) {
  const rows = (meta.held ?? []).filter((r) => !project || r.repo === project);
  if (!rows.length) return null;
  return (
    <Part title={t("Held")} count={rows.length} empty="">
      {rows.map((r) => (
        <Row key={key(r)} item={{ ...r, state: "open" as const }} line={r.line} action={<HoldButton m={r} held />} />
      ))}
    </Part>
  );
}

function ModelCalls({ user }: { user: ViewProps["user"] }) {
  const q = useQuery<ModelQueue>("model-queue", (a) => a.modelQueue.get());
  const write = useWrite();
  const base = useMemo(() => nowMs(), [q.data]);
  const now = useNow(q.data?.calls.length ? 30_000 : undefined);
  const calls = q.data?.calls ?? [];
  return (
    <section aria-label={t("Model calls waiting")} className="flex flex-col gap-1">
      <h2 className="mt-2 text-sm font-semibold text-ink/70">
        {t("Model calls waiting")} <span className="num font-normal">({calls.length})</span>
      </h2>
      <ErrorLine error={q.error?.message ?? write.error} />
      {calls.length ? (
        <ul className="rounded-lg border border-line bg-panel">
          {calls.map((c) => (
            <ModelCallRow key={c.id} c={c} user={user} waited={c.waitedMs + Math.max(0, now - base)} write={write} />
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-line px-3 py-3 text-sm text-ink/70">{t("No model call is waiting.")}</p>
      )}
    </section>
  );
}

/** A paused breaker: one repo's resumes through the workflow control, an instance-wide one through the pipeline route. */
function TripRow({ trip }: { trip: StageTrip }) {
  const api = useApi();
  const write = useWrite();
  const go = async () => {
    if (trip.repo) {
      const r = await api.controls.run({ control: "resume-breaker", key: trip.key });
      if (!r.ok) throw new Error(r.line);
    } else await api.pipeline.resumeTrip(trip.key);
  };
  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <WarningIcon aria-hidden className="mt-1 shrink-0 text-warn" />
      <div className="min-w-0 flex-1 text-sm">
        <p>{trip.reason}</p>
        <p className="text-ink/70">{t("Paused since {at}", { at: clock(trip.since) })}</p>
        <ErrorLine error={write.error} className="text-2xs" />
      </div>
      {trip.canResume && (
        <Button size="sm" className={small} loading={write.busy === "resume"} onClick={() => void write.run("resume", go)}>
          {t("Resume")}
        </Button>
      )}
    </li>
  );
}

const runnerOf = (live: LiveBoard | undefined, i: { repo: string; number: number }) => live?.workers?.find((w) => w.calls.some((c) => !c.end && c.item && key(c.item) === key(i)))?.name;

export function QueueView({ user }: ViewProps) {
  const project = usePageProject();
  const { data, error } = useQuery("next-page", (a) => a.next());
  const live = useQuery("live", (a) => a.live()).data;
  const meta = useQuery("maintain-queue", (a) => a.maintain.queue()).data ?? { approvedBy: {}, held: [] };
  const limits = useQuery("pipeline-state", (a) => a.pipeline.state()).data;
  const health = useQuery("health", (a) => a.health()).data;
  if (!data) return <Pending error={error} />;
  const inScope = (repo: string | null) => !project || !repo || repo === project;
  const trips = (limits?.limits ?? []).flatMap((l) => l.trips ?? []).filter((tr) => inScope(tr.repo));
  const overdue = (health?.problems ?? []).filter((p) => p.area === "deadline");
  const lanes = (live?.lanes ?? []).filter((l) => l.state === "running" && l.item && !l.key.startsWith("batch:") && inScope(l.repo));
  const running = lanes.length
    ? lanes.map((l) => ({ item: l.item!, line: [l.title, runnerOf(live, l.item!) && t("on {runner}", { runner: runnerOf(live, l.item!)! }), t("since {at}", { at: clock(l.start) })].filter(Boolean).join(" · ") }))
    : data.steps.flatMap((s) => s.items.filter((i) => i.inFlight).map((i) => ({ item: i, line: s.title })));
  const waitCount = trips.length + overdue.length + data.waitingTotal;
  return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto flex max-w-[768px] flex-col gap-3 px-4 pb-10 pt-5 md:px-6">
          <h1 className="text-xl font-semibold">{t("Work queue")}</h1>
          <Part title={t("Running now")} count={running.length} empty={t("Nothing runs right now.")}>
            {running.map(({ item, line }) => (
              <Row key={`${key(item)}:${line}`} item={item} line={line} />
            ))}
          </Part>
          <Part title={t("Waiting")} count={waitCount} empty={t("Nothing waits.")}>
            {trips.map((tr) => (
              <TripRow key={tr.key} trip={tr} />
            ))}
            {overdue.map((p) => (
              <li key={p.id} className="relative flex items-start gap-3 px-3 py-2.5 hover:bg-ink/[0.025]">
                <WarningIcon aria-hidden className="mt-1 shrink-0 text-warn" />
                <Link to={p.to} className="min-w-0 flex-1 text-sm after:absolute after:inset-0 hover:underline">
                  {p.text}
                  {p.since && <span className="text-ink/70"> · {t("since {at}", { at: clock(p.since) })}</span>}
                </Link>
              </li>
            ))}
            {data.waiting.map((w, i) => (
              <Row key={key(w)} item={w} line={<><span className="num mr-1.5 text-ink/60">{i + 1}.</span>{w.wait}{w.why ? <span className="text-ink/70"> · {w.why}</span> : null}</>} />
            ))}
          </Part>
          <MergeQueue project={project} meta={meta} />
          <HeldItems project={project} meta={meta} />
          <ModelCalls user={user} />
        </div>
      </div>
  );
}
