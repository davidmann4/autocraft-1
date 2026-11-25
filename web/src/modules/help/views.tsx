// Help pages: Getting started, Commands, After a command, Workflows, Who can do what, Keyboard.
import { Fragment, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowDownIcon, ArrowLeftIcon, CaretRightIcon, ChatCircleIcon } from "@phosphor-icons/react";
import { t } from "../../../../src/i18n/index.ts";
import { COMMANDS, CONTROLS, ENTRY_LABEL, WEIGHT_HELP, type CommandDef } from "../../../../src/workflow/vocab.ts";
import { blockerLabel, stepLabel, stepsFor, type StepName } from "../../../../src/workflow/status.ts";
import type { Blocker, Entry } from "../../../../src/workflow/types.ts";
import type { ViewProps } from "../../registry/types";
import { modules } from "../../registry";
import { cn } from "../../ui/cn";
import { useQuery } from "../../api/client";

/** What to type after the `@` in a GitHub comment: the app's mention name or slug; a placeholder until it is known or without an app. */
function useMention(): string {
  const { data } = useQuery("mention", (api) => api.mention());
  return data?.mention ?? "app";
}

const MAIN = COMMANDS.filter((c) => !c.more);
const MORE = COMMANDS.filter((c) => c.more);
const BLOCKERS: Blocker[] = ["major-finding", "author-commits", "failed-twice", "beyond-agreed", "large-fix", "outside-purpose"];
const ENTRIES: Entry[] = ["review", "fixup", "implement"];
const ITEM = "photocraft#812";

const PAGES = [
  { id: "start", title: () => t("Getting started") },
  { id: "commands", title: () => t("Commands") },
  { id: "after", title: () => t("After a command") },
  { id: "workflows", title: () => t("Workflows") },
  { id: "roles", title: () => t("Who can do what") },
  { id: "keyboard", title: () => t("Keyboard") },
];

const Code = ({ children }: { children: ReactNode }) => <code className="code rounded bg-ink/[0.07] px-1 py-0.5 text-[0.9em]">{children}</code>;

function Part({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section id={id} aria-label={title} className="flex flex-col gap-1.5 border-t border-line pt-4">
      <h2 className="text-md font-semibold">{title}</h2>
      {children}
    </section>
  );
}

const arrow = (names: StepName[]) => names.map((n) => stepLabel({ name: n, state: "next" })).join(" → ");
const first = (word: string) => word.split(" ")[0]!;

function Page({ id, children }: { id: string; children: ReactNode }) {
  const i = PAGES.findIndex((p) => p.id === id);
  const next = PAGES[i + 1];
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 text-md leading-relaxed">
      <Link to="/help" className="inline-flex h-11 w-fit items-center gap-1.5 rounded text-sm text-ink/70 hover:text-ink">
        <ArrowLeftIcon aria-hidden /> {t("Help")}
      </Link>
      <h1 className="text-xl font-semibold">{PAGES[i]!.title()}</h1>
      {children}
      {next && (
        <Link to={`/help/${next.id}`} className="mt-2 flex min-h-12 items-center justify-between rounded-lg border border-line px-3 text-md hover:bg-ink/[0.04]">
          <span>
            <span className="text-sm text-ink/70">{t("Next:")} </span>
            {next.title()}
          </span>
          <CaretRightIcon aria-hidden className="text-ink/60" />
        </Link>
      )}
    </div>
  );
}

function Start() {
  const mention = useMention();
  return (
    <Page id="start">
      <p>{t("AutoCraft reviews, fixes, implements and merges issues and pull requests. It classifies everything new on its own. It does more only when a maintainer sends a command, except small and medium bug fixes, which it handles itself.")}</p>
      <Part title={t("Connect a Task Runner")}>
        <p>
          {t("Model work runs on Task Runners: maintainers' own machines, on their own subscription. Run")} <Code>autocraft login</Code> {t("on yours, then pick what it takes on the")}{" "}
          <Link to="/runner" className="rounded text-accent-ink underline underline-offset-2">
            {t("Runner page")}
          </Link>
          .
        </p>
        <p>{t("Without one, your work waits for another runner that takes it. Home shows how many there are.")}</p>
      </Part>
      <Part title={t("Link Discord")}>
        <p>
          {t("Link your Discord account on the Runner page, so")} <Code>/autocraft do</Code> {t("acts as you.")}
        </p>
      </Part>
      <Part title={t("Where to type commands")}>
        <ul className="flex list-disc flex-col gap-1 pl-5">
          <li>
            {t("GitHub: a comment that starts with the app's name,")} <Code>{`@${mention} ${COMMANDS[1]!.example}`}</Code>
          </li>
          <li>
            {t("Discord:")} <Code>{`/autocraft do text:${COMMANDS[1]!.example} ${ITEM}`}</Code>
          </li>
          <li>{t("Your agent: the AutoCraft tools take the same words.")}</li>
          <li>{t("This app: the command box on an item, or Command on Items.")}</li>
        </ul>
      </Part>
    </Page>
  );
}

function Surfaces({ c }: { c: CommandDef }) {
  const mention = useMention();
  const dt = "text-ink/70";
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt className={dt}>GitHub</dt>
      <dd className="min-w-0 break-words">
        <Code>{`@${mention} ${c.example}`}</Code>
      </dd>
      <dt className={dt}>Discord</dt>
      <dd className="min-w-0 break-words">
        <Code>{`/autocraft do text:${c.example} ${ITEM}`}</Code>
      </dd>
      <dt className={dt}>{t("Agent")}</dt>
      <dd className="min-w-0 break-words">“{`${c.example} ${ITEM}`}”</dd>
      <dt className={dt}>{t("App")}</dt>
      <dd className="min-w-0 break-words">{t("{word} in the item's command box", { word: c.example })}</dd>
    </dl>
  );
}

function Commands() {
  return (
    <Page id="commands">
      <p>{t("The same words work everywhere. Combine them in one message.")}</p>
      <nav aria-label={t("Commands")} className="flex flex-wrap gap-1.5">
        {MAIN.map((c) => (
          <a key={c.word} href={`#cmd-${first(c.word)}`} className="code inline-flex h-11 items-center rounded border border-line px-2.5 text-sm hover:bg-ink/[0.06]">
            {c.word}
          </a>
        ))}
      </nav>
      {MAIN.map((c) => (
        <Part key={c.word} id={`cmd-${first(c.word)}`} title={c.usage}>
          <p>{t(c.does)}</p>
          {c.entry && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              {c.entry === "merge" ? (
                <>
                  <dt className="text-ink/70">{t("Unstarted PR")}</dt>
                  <dd>{arrow(stepsFor("merge", true))}</dd>
                </>
              ) : (
                <>
                  <dt className="text-ink/70">{t("Runs")}</dt>
                  <dd>{arrow(stepsFor(c.entry, false))}</dd>
                  <dt className="text-ink/70">{t("With merge")}</dt>
                  <dd>{arrow(stepsFor(c.entry, true))}</dd>
                </>
              )}
            </dl>
          )}
          <p className="text-sm">
            <span className="text-ink/70">{t("Comes back:")} </span>
            {t(c.back)}
          </p>
          <Surfaces c={c} />
        </Part>
      ))}
      <Part title={t("Weight")}>
        <p>{t("Add a weight anywhere in a command to order the queues. Heavier goes first.")}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {WEIGHT_HELP.map((w) => (
            <Fragment key={w.word}>
              <dt className="code">{t(w.word)}</dt>
              <dd>{t(w.weight)}</dd>
            </Fragment>
          ))}
        </dl>
        <p>
          <Code>fix-up and merge, urgent</Code>. {t("On a started item the word alone changes it:")} <Code>@&lt;app&gt; urgent</Code>.
        </p>
      </Part>
      <Part title={t("Combining")}>
        <p>
          <Code>fix-up and merge</Code>, <Code>implement and merge</Code>, <Code>fix 1, drop 2, then merge</Code>.
        </p>
      </Part>
      <Part title={t("Several items")}>
        <p>
          {t("Write them inline on Discord and in an agent:")} <Code>merge photocraft#803 photocraft#19</Code>. {t("In every surface, a list after a colon works too:")} <Code>merge, urgent: photocraft#803 #19</Code>. {t("A bare number takes the repo before it. Each item gets its own answer line.")}
        </p>
      </Part>
      <Part title={t("More commands")}>
        {MORE.map((c) => (
          <p key={c.word}>
            <Code>{c.usage}</Code>: {t(c.does)} <Code>{c.example}</Code>
          </p>
        ))}
      </Part>
      <Part title={t("Controls")}>
        <p>{t("Buttons for what a command word does not cover. The agent has them as commands too.")}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {CONTROLS.map((c) => (
            <Fragment key={c.control}>
              <dt className="font-semibold">{t(c.name)}</dt>
              <dd>{t(c.short)}</dd>
            </Fragment>
          ))}
        </dl>
      </Part>
    </Page>
  );
}

function After() {
  return (
    <Page id="after">
      <Part title={t("The confirmation")}>
        <p>{t("Every accepted command gets one line back, the same on every surface. It says what runs next, who sent it, and ends with how to stop.")}</p>
        <p className="rounded border border-line bg-sunken px-3 py-2 text-sm">{t("Fixing 1 and 2, then merging when CI is green (approved by mira, 09:31 UTC). Reply stop to halt.")}</p>
      </Part>
      <Part title={t("On GitHub")}>
        <p>{t("One status comment per started item, edited in place: the steps, the state, the open recommendation and who approved.")}</p>
      </Part>
      <Part title={t("Following progress")}>
        <p>{t("The item page shows the steps and history beside the GitHub activity. The Work queue shows what runs, what waits and why.")}</p>
      </Part>
      <Part title={t("Merge approval")}>
        <p>
          <Code>merge</Code> {t("approves. An approved item merges when its steps are done and CI is green. Without approval, AutoCraft comes back with one recommendation.")}
        </p>
        <p>{t("An approved item comes back to you only at a blocker:")}</p>
        <ol className="list-decimal pl-6 text-sm">
          {BLOCKERS.map((b) => (
            <li key={b}>{blockerLabel(b)}</li>
          ))}
        </ol>
        <p className="text-sm">{t("At a blocker the approval stays. A yes resumes the plan.")}</p>
      </Part>
      <Part title={t("Answering a recommendation")}>
        <ul className="flex list-disc flex-col gap-1 pl-5">
          <li>
            <Code>yes</Code>, <Code>lgtm</Code>, <Code>go</Code>: {t("runs the recommendation.")}
          </li>
          <li>
            {t("An instruction,")} <Code>fix 1, drop 2, then merge</Code>: {t("runs as written.")}
          </li>
          <li>{t("Anything unclear runs nothing. AutoCraft says what it understood and waits.")}</li>
        </ul>
      </Part>
      <Part title={t("Stopping")}>
        <p>
          <Code>stop</Code> {t("halts all work on the item at once. Any command starts it again.")}
        </p>
      </Part>
    </Page>
  );
}

const box = "rounded border border-line-strong bg-raised px-2.5 py-1";
const Down = () => (
  <li aria-hidden className="ml-3 text-ink/50">
    <ArrowDownIcon />
  </li>
);
const Asked = () => <ChatCircleIcon aria-label={t("A person is asked")} className="mr-1 inline align-[-2px] text-accent-ink" />;

/** A step list drawn top to bottom, ending in branches when there are any. Asked branches carry the speech-bubble mark. */
function Flow({ steps, ends }: { steps: StepName[]; ends?: [string, string, boolean?][] }) {
  return (
    <ol className="flex flex-col items-start gap-0.5 text-sm">
      {steps.map((s, i) => (
        <Fragment key={i}>
          {i > 0 && <Down />}
          <li className={box}>{stepLabel({ name: s, state: "next" })}</li>
        </Fragment>
      ))}
      {ends && (
        <>
          <Down />
          <li className="flex flex-col gap-1">
            {ends.map(([when, what, asked]) => (
              <span key={when} className={cn(box, asked && "border-accent/60 bg-accent/10")}>
                <span className="text-ink/70">{when}: </span>
                {asked && <Asked />}
                {what}
              </span>
            ))}
          </li>
        </>
      )}
    </ol>
  );
}

function Workflows() {
  return (
    <Page id="workflows">
      <p>
        {t("A command picks where the item enters.")} <Asked />
        {t("marks where a person is asked.")}
      </p>
      <Part title={t("Automatic, for everything new")}>
        <ol className="flex flex-col items-start gap-0.5 text-sm">
          <li className={box}>{t("classify: kind, size, duplicates, priority")}</li>
          <Down />
          <li className="flex flex-col gap-1">
            <span className={box}>
              <span className="text-ink/70">{t("Small or medium bug fix:")} </span>
              {t("review → fix-up if needed → merge")}
            </span>
            <span className={cn(box, "border-accent/60 bg-accent/10")}>
              <span className="text-ink/70">{t("Anything else:")} </span>
              <Asked />
              {t("waits for a maintainer's command")}
            </span>
          </li>
        </ol>
      </Part>
      {ENTRIES.map((e) => (
        <Part key={e} title={t(ENTRY_LABEL[e])}>
          <Flow
            steps={stepsFor(e, false).slice(0, -1)}
            ends={[
              [t("Approved"), t("merge when CI is green")],
              [t("Not approved"), t("one recommendation"), true],
            ]}
          />
        </Part>
      ))}
      <Part title={t(ENTRY_LABEL.merge)}>
        <p className="text-sm">{t("No review. Approval is implied.")}</p>
        <Flow steps={stepsFor("merge", true)} />
      </Part>
      <Part title={t("At any step")}>
        <p>
          <Asked />
          {t("A blocker stops the item and asks, even when it is approved.")}
        </p>
      </Part>
    </Page>
  );
}

function Roles() {
  const rows: [string, string[]][] = [
    [t("Viewer"), [t("Reads items, Work queue, Stats, Prompts, Environments, Repos and Scans, without security findings."), t("Sends no commands.")]],
    [t("Maintainer (write access on the repo)"), [t("Starts, answers, approves the merge, stops and closes any item in that repo."), t("Turns the repo's automatic handling on or off, resumes paused steps and releases holds."), t("Starts security scans with a spend cap and sees their findings."), t("Connects a Task Runner.")]],
    [t("Operator"), [t("Everything a maintainer can, on every repo."), t("Admin: users and access, accounts, inference, GitHub App, Discord, limits, health, sweeps, audit log.")]],
    [t("Outside contributor"), [t("Sees the status of their own issues and pull requests.")]],
  ];
  return (
    <Page id="roles">
      <p>{t("Every action is logged with who did it: “approved by mira”, “stopped by jonas”.")}</p>
      {rows.map(([who, can]) => (
        <Part key={who} title={who}>
          <ul className="flex list-disc flex-col gap-1 pl-5">
            {can.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </Part>
      ))}
    </Page>
  );
}

function Keyboard() {
  const all = [
    { id: "search", keys: "/", label: t("Search"), group: t("Anywhere") },
    { id: "help", keys: "?", label: t("Keyboard shortcuts"), group: t("Anywhere") },
    { id: "rail", keys: "[", label: t("Toggle sidebar"), group: t("Anywhere") },
    ...modules.flatMap((m) => m.commands ?? []),
  ];
  const groups = [...new Set(all.map((c) => c.group))];
  return (
    <Page id="keyboard">
      <p>{t("Press ? anywhere for this list.")}</p>
      {groups.map((g) => (
        <Part key={g} title={g}>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
            {all
              .filter((c) => c.group === g)
              .map((c) => (
                <Fragment key={c.id}>
                  <dt>{c.label}</dt>
                  <dd>
                    <Code>{c.keys}</Code>
                  </dd>
                </Fragment>
              ))}
          </dl>
        </Part>
      ))}
    </Page>
  );
}

export function HelpView({ params }: ViewProps) {
  const page = params.page;
  if (page === "start") return <Start />;
  if (page === "commands") return <Commands />;
  if (page === "after") return <After />;
  if (page === "workflows") return <Workflows />;
  if (page === "roles") return <Roles />;
  if (page === "keyboard") return <Keyboard />;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 text-md leading-relaxed">
      <h1 className="text-xl font-semibold">{t("How to use AutoCraft")}</h1>
      <p>{t("Tell AutoCraft what to do with an issue or pull request: on GitHub, in Discord, from your agent or here. The words are the same everywhere.")}</p>
      <ul className="divide-y divide-line rounded-lg border border-line bg-panel">
        {PAGES.map((p) => (
          <li key={p.id}>
            <Link to={`/help/${p.id}`} className="flex min-h-12 items-center justify-between rounded px-3 hover:bg-ink/[0.04]">
              {p.title()}
              <CaretRightIcon aria-hidden className="text-ink/60" />
            </Link>
          </li>
        ))}
      </ul>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg border border-line bg-raised px-3 py-3 text-sm">
        {MAIN.map((c) => (
          <Fragment key={c.word}>
            <dt className="code font-semibold">{c.word}</dt>
            <dd>{t(c.short)}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}
