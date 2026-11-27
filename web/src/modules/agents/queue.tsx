// The model call queue of the user-local inference mode: queued calls, why each waits, and picks for the user's own Task Runners.
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { LightningIcon } from "@phosphor-icons/react";
import { useApi, useQuery } from "../../api/client";
import type { ModelQueue, ModelQueueCall, ModelQueueWhyCode, User } from "../../api/types";
import type { ViewProps } from "../../registry/types";
import { nowMs, span } from "../../lib/format";
import { useNow } from "../../lib/useNow";
import { useWrite } from "../../lib/hooks";
import { formatCost } from "../../lib/trace";
import { Badge, type Tone } from "../../ui/atoms/Badge";
import { Button } from "../../ui/atoms/Button";
import { EmptyState } from "../../ui/atoms/EmptyState";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Block } from "../../ui/molecules/Block";
import { ItemRef } from "../../ui/molecules/ItemRef";
import { Segmented } from "../../ui/molecules/Segmented";
import { Page } from "../../ui/organisms/Page";

/** The switch between the Model calls page (runs) and the queue, shown in the user-local inference mode. */
export function RunsQueueSwitch({ value }: { value: "runs" | "queue" }) {
  const nav = useNavigate();
  return (
    <Segmented
      label="Model calls"
      value={value}
      options={[
        { value: "runs", label: "Runs" },
        { value: "queue", label: "Queue" },
      ]}
      onChange={(v) => nav(v === "queue" ? "/model-queue" : "/agents")}
      className="mt-3"
    />
  );
}

const WHY_TONE: Record<ModelQueueWhyCode, Tone> = { picked: "accent", session: "neutral", bound: "neutral", "bound-off": "warn", owner: "neutral", "owner-off": "warn", login: "neutral", "no-runner": "warn", "manual-only": "warn", busy: "neutral", "no-repo-access": "warn", "task-off": "warn", "items-off": "warn", behind: "neutral" };

export function ModelQueueView({ user }: ViewProps) {
  const q = useQuery<ModelQueue>("model-queue", (a) => a.modelQueue.get());
  const write = useWrite();
  // Waits keep counting between refetches, from the moment this reply arrived.
  const base = useMemo(() => nowMs(), [q.data]);
  const now = useNow(q.data?.calls.length ? 30_000 : undefined);
  const staff = user.role !== "viewer";
  const d = q.data;
  const runners = d && (
    <span className="num">
      {d.runners.autopilot} on autopilot · {d.runners.manual} Manual only
      {d.runners.manualLogins?.length ? ` (${d.runners.manualLogins.join(", ")})` : ""}
    </span>
  );
  return (
    <Page title="Model call queue">
      <RunsQueueSwitch value="queue" />
      <Block
        className="mt-4"
        flush
        title={<>Queued {d && <span className="num ml-1 font-normal text-ink/50">{d.calls.length}</span>}</>}
        aside={d && staff && (d.me.canPick || d.me.picks > 0) ? <span className="num">My picks {d.me.picks}/{d.me.pickMax}</span> : undefined}
      >
        {d && <p className="border-b border-line px-4 py-2 text-xs text-ink/60">Task Runners: {runners}</p>}
        <ErrorLine error={q.error?.message ?? write.error} className="px-4 pt-3" />
        {d && !d.calls.length && <EmptyState>No model call is waiting.</EmptyState>}
        <ul>
          {d?.calls.map((c) => (
            <QueueRow key={c.id} c={c} user={user} waited={c.waitedMs + Math.max(0, now - base)} write={write} />
          ))}
        </ul>
      </Block>
    </Page>
  );
}

export function QueueRow({ c, user, waited, write }: { c: ModelQueueCall; user: User; waited: number; write: ReturnType<typeof useWrite> }) {
  const api = useApi();
  const staff = user.role !== "viewer";
  const mine = !!c.picked?.login && c.picked.login.toLowerCase() === user.login.toLowerCase();
  const canUnpick = staff && !!c.picked && (mine || user.role === "operator");
  const cost = formatCost(c.estCostUsd);
  return (
    <li className="flex flex-col gap-2 border-b border-line px-4 py-2.5 last:border-0 md:flex-row md:items-start md:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">{c.kind}</span>
          <Badge tone="accent">
            {c.tier} · {c.model}
          </Badge>
          {c.followUp && <Badge>follow-up</Badge>}
          {c.gating && <Badge>gating</Badge>}
        </div>
        <div className="mt-1 flex flex-col items-start gap-0.5">
          {c.items.map((i) => (
            <ItemRef key={`${i.repo}#${i.number}`} repo={i.repo} number={i.number} kind={i.kind} state={i.state} title={i.title} size="sm" className="w-fit max-w-full" />
          ))}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink/65">
          <span className="num">waited {span(waited)}</span>
          <span className="num">est. {cost ?? "–"}</span>
          {c.why.code !== "picked" && <Badge tone={WHY_TONE[c.why.code]}>{c.why.text}</Badge>}
        </div>
        {c.lastError && <p className="mt-1 break-words text-xs text-bad">{c.lastError}</p>}
      </div>
      {(c.picked || (staff && c.pickable)) && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {c.picked ? (
            <>
              <Badge tone="accent">{c.picked.login ? `Picked by ${c.picked.login}` : "Picked"}</Badge>
              {canUnpick && (
                <Button size="sm" variant="ghost" loading={write.busy === `unpick:${c.id}`} onClick={() => void write.run(`unpick:${c.id}`, () => api.modelQueue.unpick(c.id))}>
                  Unpick
                </Button>
              )}
            </>
          ) : (
            <Button icon={LightningIcon} variant="primary" size="sm" loading={write.busy === `pick:${c.id}`} onClick={() => void write.run(`pick:${c.id}`, () => api.modelQueue.pick(c.id))}>
              Run on my Task Runner
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
