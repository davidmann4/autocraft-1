// Home: the Task Runner line, then the reader's own items (started, approved, held or asked), most recently updated first, with
// the conversation's last line. Viewers see what waits for a maintainer.
import { Link } from "react-router-dom";
import { CaretRightIcon, WarningCircleIcon, XCircleIcon } from "@phosphor-icons/react";
import { t } from "../../../../../src/i18n/index.ts";
import { useQuery } from "../../../api/client";
import type { HomeProblem, MaintainRow, MaintainRunnerLine } from "../../../api/types";
import { useUser } from "../../../shell/UserContext";
import { Pending } from "../../../ui/atoms/Pending";
import { messageTime } from "../../../lib/format";
import { cn } from "../../../ui/cn";
import { ItemRef } from "../../../ui/molecules/ItemRef";
import { GithubButton } from "../../../ui/atoms/GithubButton";
import { githubItemUrl } from "../../../lib/links";
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
    <Link to="/runner" className="flex min-h-11 items-center gap-2.5 rounded-xl border border-line bg-raised px-3.5 py-2.5 text-sm hover:bg-ink/[0.04]">
      <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", dot)} />
      <span className="min-w-0 flex-1">
        {text}
        {action && <span className="font-semibold text-accent-ink"> · {action}</span>}
      </span>
      <CaretRightIcon aria-hidden className="shrink-0 text-ink/60" />
    </Link>
  );
}

const OWN_SHOWN = 8;

/** One of the reader's items: the item, the conversation's last line, and a dot when that line is a question to the reader. */
function OwnRow({ r }: { r: MaintainRow }) {
  const ask = !!r.last?.question;
  const by = r.last?.by ?? "AutoCraft";
  return (
    <li className="relative flex items-start gap-2.5 py-3 pl-2.5 pr-3 transition-colors duration-fast hover:bg-ink/[0.03]">
      <span aria-hidden className={cn("mt-[6px] size-2 shrink-0 rounded-full", ask ? "bg-accent" : "bg-transparent")} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-3">
          <ItemRef repo={r.repo} number={r.number} kind={r.kind} state={r.state ?? "open"} title={r.title} stretch github={false} className="min-w-0 flex-1 font-medium" />
          <time dateTime={r.updatedAt} className="num mt-0.5 shrink-0 whitespace-nowrap text-xs text-ink/70">{messageTime(r.updatedAt)}</time>
          <GithubButton href={githubItemUrl(r.repo, r.number, r.kind)} label={t("Open {ref} on GitHub", { ref: `${r.repo}#${r.number}` })} className="mt-[calc((1lh-1.75rem)/2)]" />
        </div>
        <p className={cn("mt-1 line-clamp-2 pl-6 text-sm", ask ? "font-medium text-accent-ink" : "text-ink/70")}>
          {ask && <span className="sr-only">{t("Question for you:")} </span>}
          <span className={ask ? undefined : "text-ink"}>{by === "AutoCraft" ? "AutoCraft" : `@${by}`}</span>: {r.last?.text ?? r.line}
        </p>
      </div>
    </li>
  );
}

function OwnItems({ rows, total }: { rows: MaintainRow[]; total: number }) {
  const title = t("My items");
  return (
    <section aria-labelledby="home-own" className="flex flex-col gap-1">
      <h2 id="home-own" className="mb-1 mt-4 text-md font-semibold">
        {title}
      </h2>
      {rows.length ? (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-raised">
          {rows.slice(0, OWN_SHOWN).map((r) => (
            <OwnRow key={`${r.repo}#${r.number}`} r={r} />
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-line px-3 py-3 text-sm text-ink/70">{t("Nothing started or approved by you.")}</p>
      )}
      {total > rows.length && <Link to="/items?filter=mine" className="mt-1 inline-flex min-h-11 w-fit items-center gap-1 self-center rounded px-3 text-sm font-medium text-accent-ink hover:underline">
        {t("Show more")} <CaretRightIcon aria-hidden />
      </Link>}
    </section>
  );
}

function List({ title, rows }: { title: string; rows: MaintainRow[] }) {
  if (!rows.length) return null;
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h2 className="mt-2 text-sm font-semibold text-ink/70">{title}</h2>
      <ul className="divide-y divide-line rounded-lg border border-line bg-panel">
        {rows.map((r) => (
          <li key={`${r.repo}#${r.number}`} className="relative px-3 py-2.5 hover:bg-ink/[0.025]">
            <ItemRef repo={r.repo} number={r.number} kind={r.kind} state="open" title={r.title} stretch />
            <p className="mt-0.5 pl-6 text-sm text-ink/70">{r.line}</p>
          </li>
        ))}
      </ul>
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

export function HomeView(_: ViewProps) {
  const user = useUser();
  const { data, error } = useQuery("maintain-home", (a) => a.maintain.home());
  if (!data) return <Pending error={error} />;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[784px] flex-col gap-3 px-4 pb-12 pt-5 md:px-8 md:pt-8">
        <h1 className="text-xl font-semibold tracking-[-0.01em] md:text-2xl">{t("Home")}</h1>
        {data.runner && <RunnerLine r={data.runner} />}
        <Attention rows={data.attention} />
        {user.role === "viewer" ? <List title={t("Recently updated")} rows={data.recent} /> : <OwnItems rows={data.mine} total={data.mineTotal} />}
      </div>
    </div>
  );
}
