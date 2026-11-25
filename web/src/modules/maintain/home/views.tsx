// Home: the Task Runner line, what waits for the reader's answer, what they started, problems, stuck items and the live board.
// Viewers see what waits for a maintainer and what runs. Every list updates in place from the live topics.
import { Link } from "react-router-dom";
import { CaretRightIcon, WarningCircleIcon, XCircleIcon } from "@phosphor-icons/react";
import { t } from "../../../../../src/i18n/index.ts";
import { useQuery } from "../../../api/client";
import { usePageProject } from "../../../api/scope";
import type { HomeProblem, MaintainRow, MaintainRunnerLine } from "../../../api/types";
import { itemPath } from "../../../lib/links";
import { useUser } from "../../../shell/UserContext";
import { Badge } from "../../../ui/atoms/Badge";
import { ItemIcon } from "../../../ui/atoms/ItemIcon";
import { Pending } from "../../../ui/atoms/Pending";
import { cn } from "../../../ui/cn";
import { LiveBoard } from "../../home/LiveBoard";
import type { ViewProps } from "../../../registry/types";

const calls = (n: number) => (n === 1 ? t("1 call running") : t("{n} calls running", { n }));
const others = (n: number) => (n === 0 ? t("no others available") : n === 1 ? t("1 other available") : t("{n} others available", { n }));

/** One line about the reader's Task Runners; it opens the Runner page. */
function RunnerLine({ r }: { r: MaintainRunnerLine }) {
  const online = r.mine.filter((m) => m.online);
  const running = online.reduce((s, m) => s + m.running, 0);
  const [dot, text, action]: [string, string, string | null] = online.length
    ? ["bg-ok", online.length === 1 ? t("Your Task Runner: {name} online, {calls}", { name: online[0]!.name, calls: calls(running) }) : t("{n} Task Runners online, {calls}", { n: online.length, calls: calls(running) }), null]
    : r.mine.length
      ? ["bg-warn", r.mine.length === 1 ? t("Your Task Runner {name} is offline · {others}", { name: r.mine[0]!.name, others: others(r.others) }) : t("Your Task Runners are offline · {others}", { others: others(r.others) }), null]
      : r.others
        ? ["bg-warn", t("0 Task Runners connected · {others}", { others: others(r.others) }), t("Set up a Task Runner")]
        : ["bg-bad", t("0 Task Runners connected"), t("Set up a Task Runner")];
  return (
    <Link to="/runner" className="flex min-h-11 items-center gap-2.5 rounded-lg border border-line bg-raised px-3 py-2 text-sm hover:bg-ink/[0.04]">
      <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", dot)} />
      <span className="min-w-0 flex-1">
        {text}
        {action && <span className="font-semibold text-accent-ink"> · {action}</span>}
      </span>
      <CaretRightIcon aria-hidden className="shrink-0 text-ink/60" />
    </Link>
  );
}

/** Who started it and whether it is approved for merge, for the reader's own items. */
function byLine(r: MaintainRow): string {
  const started = t("started by {login}", { login: r.startedBy });
  const approved = r.approvedBy ? t("approved by {login}", { login: r.approvedBy }) : t("not approved");
  return r.stoppedBy ? t("{started}, stopped by {login}", { started, login: r.stoppedBy }) : t("{started}, {approved}", { started, approved });
}

function ItemRow({ r, by }: { r: MaintainRow; by?: boolean }) {
  return (
    <li className="relative flex items-start gap-3 px-3 py-3 hover:bg-ink/[0.025]">
      <ItemIcon kind={r.kind} state="open" className="mt-0.5" tip={false} />
      <div className="min-w-0 flex-1">
        <Link to={itemPath(r.repo, r.number)} className="block rounded text-md font-medium leading-snug after:absolute after:inset-0 hover:underline">
          {r.title}
        </Link>
        <div className="mt-0.5 text-xs text-ink/70">
          <span className="code">
            {r.repo}#{r.number}
          </span>
          {r.author && <> · {r.author}</>}
        </div>
        <div className="mt-1 line-clamp-2 text-sm">
          {r.weight && (
            <Badge tone={r.weight === "urgent" ? "bad" : r.weight === "low" ? "neutral" : "warn"} className="mr-1.5">
              {r.weight}
            </Badge>
          )}
          {r.blocked && <span className="text-bad">{t("Blocker")} · </span>}
          <span className={r.waits ? "text-accent-ink" : "text-ink/80"}>{r.line}</span>
          {by && <span className="text-ink/70"> · {byLine(r)}</span>}
        </div>
      </div>
    </li>
  );
}

function List({ title, rows, empty, by }: { title: string; rows: MaintainRow[]; empty?: string; by?: boolean }) {
  if (!rows.length && !empty) return null;
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h2 className="mt-2 text-sm font-semibold text-ink/70">
        {title} {rows.length > 0 && <span className="num font-normal">({rows.length})</span>}
      </h2>
      {rows.length ? (
        <ul className="divide-y divide-line rounded-lg border border-line bg-panel">
          {rows.map((r) => (
            <ItemRow key={`${r.repo}#${r.number}`} r={r} by={by} />
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-line px-3 py-3 text-sm text-ink/70">{empty}</p>
      )}
    </section>
  );
}

/** Problems: stopped steps, failing checks, fixes that gave up. Shown only when there are some. */
function Attention({ rows }: { rows: HomeProblem[] }) {
  if (!rows.length) return null;
  const title = t("Needs attention");
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h2 className="mt-2 text-sm font-semibold text-ink/70">
        {title} <span className="num font-normal">({rows.length})</span>
      </h2>
      <ul className="divide-y divide-line rounded-lg border border-line bg-panel">
        {rows.map((p) => (
          <li key={`${p.kind}${p.to}${p.title}`} className="relative flex items-start gap-3 px-3 py-3 hover:bg-ink/[0.025]">
            {p.kind === "stopped" ? <XCircleIcon weight="fill" aria-label={t("Stopped")} className="mt-[3px] shrink-0 text-bad" /> : <WarningCircleIcon weight="fill" aria-label={t("Warning")} className="mt-[3px] shrink-0 text-warn" />}
            <div className="min-w-0 flex-1">
              <Link to={p.to} className="text-sm font-medium after:absolute after:inset-0 hover:underline">
                {p.title}
              </Link>
              {p.detail && <div className="mt-0.5 text-xs text-ink/70">{p.detail}</div>}
            </div>
            <CaretRightIcon aria-hidden className="mt-1 shrink-0 text-ink/50" />
          </li>
        ))}
      </ul>
    </section>
  );
}

const STUCK_SHOWN = 5;

/** Open items nothing moves (the liveness check); staff only. */
function Stuck() {
  const { data } = useQuery("stuck", (a) => a.stuckItems(), { project: null });
  // The liveness check covers every repo; the page's project narrows it here.
  const project = usePageProject();
  const rows = (data?.items ?? []).filter((i) => i.verdict === "stuck" && (!project || i.repo === project));
  if (!rows.length) return null;
  const title = t("Stuck");
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <div className="mt-2 flex items-center">
        <h2 className="text-sm font-semibold text-ink/70">
          {title} <span className="num font-normal">({rows.length})</span>
        </h2>
        <Link to="/stuck" className="ml-auto inline-flex min-h-11 items-center text-xs text-accent-ink hover:underline md:min-h-0">
          {t("All stuck items")}
        </Link>
      </div>
      <ul className="divide-y divide-line rounded-lg border border-line bg-panel">
        {rows.slice(0, STUCK_SHOWN).map((i) => (
          <li key={`${i.repo}#${i.number}`} className="relative flex items-start gap-3 px-3 py-3 hover:bg-ink/[0.025]">
            <ItemIcon kind={i.kind} state="open" className="mt-0.5" tip={false} />
            <div className="min-w-0 flex-1">
              <Link to={itemPath(i.repo, i.number)} className="block text-md font-medium leading-snug after:absolute after:inset-0 hover:underline">
                {i.title ?? `${i.repo}#${i.number}`}
              </Link>
              <div className="mt-0.5 text-xs text-ink/70">
                <span className="code">
                  {i.repo}#{i.number}
                </span>{" "}
                · {i.cause}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function HomeView(_: ViewProps) {
  const user = useUser();
  const { data, error } = useQuery("maintain-home", (a) => a.maintain.home());
  if (!data) return <Pending error={error} />;
  const viewer = user.role === "viewer";
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[768px] flex-col gap-3 px-4 pb-10 pt-5 md:px-6">
        <h1 className="text-xl font-semibold">{t("Home")}</h1>
        {data.runner && <RunnerLine r={data.runner} />}
        {viewer ? (
          <>
            <List title={t("Waiting for a maintainer")} rows={data.waiting} />
            <Attention rows={data.attention} />
            <List title={t("Running")} rows={data.running} empty={t("Nothing is running.")} />
          </>
        ) : (
          <>
            <List title={t("Needs your answer")} rows={data.needs} empty={t("Nothing needs your answer.")} />
            <Attention rows={data.attention} />
            <List title={t("Started by you")} rows={data.mine} empty={t("Nothing started by you.")} by />
            <Stuck />
          </>
        )}
        <div className="mt-4">
          <LiveBoard to="/now" />
        </div>
      </div>
    </div>
  );
}
