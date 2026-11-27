// The item page: a header (repo#number, kind and state, badges, title, AutoCraft's status in one line) over the chat with
// AutoCraft, which is always the main column. GitHub (the item's GitHub side) and Events (every step AutoCraft and GitHub recorded)
// sit in a resizable side panel on wide screens and in tabs under the header on phones.
// `?tab=github|events` opens that view; `?event=<id>` opens Events on that event.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowLeftIcon,
  ChatCircleDotsIcon,
  ChatsIcon,
  CheckCircleIcon,
  CircleIcon,
  CircleNotchIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  PauseCircleIcon,
  RadioButtonIcon,
  ShieldWarningIcon,
  SidebarSimpleIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { t, tk } from "../../../../../src/i18n/index.ts";
import { useApi, useQuery } from "../../../api/client";
import type { ItemChat, ItemChatState } from "../../../api/types";
import type { ItemKind, ItemPageData, ItemState, MaintainItem, MaintainReply } from "../../../api/types";
import type { ViewProps } from "../../../registry/types";
import { useIsPhone } from "../../../shell/useMedia";
import { Badge, type Tone } from "../../../ui/atoms/Badge";
import { Button } from "../../../ui/atoms/Button";
import { EmptyState } from "../../../ui/atoms/EmptyState";
import { GithubLinkButton } from "../../../ui/atoms/GithubButton";
import { Pending } from "../../../ui/atoms/Pending";
import { cn } from "../../../ui/cn";
import { ItemRef } from "../../../ui/molecules/ItemRef";
import { SideDock, useDockState, type DockView } from "../../../ui/organisms/SideDock";
import { ItemConversation } from "./chat/ItemConversation";
import { GithubSide } from "./GithubSide";
import { History } from "./History";

type Side = "github" | "events";
const SIDES: { value: Side }[] = [{ value: "github" }, { value: "events" }];
const DOCK = "item";

/** The page read for the header facts and the GitHub view. A matching `since` costs one small reply. */
function usePage(repo: string, number: number) {
  const key = `item-page:v2:${repo}#${number}`;
  const last = useRef<{ key: string; page: ItemPageData } | null>(null);
  return useQuery<ItemPageData>(key, async (a) => {
    const prev = last.current?.key === key ? last.current.page : null;
    const r = await a.itemPage(repo, number, prev?.stamp);
    if ("unchanged" in r && prev) return prev;
    if ("unchanged" in r) throw new Error("unexpected empty answer");
    last.current = { key, page: r };
    return r;
  });
}

/** Something moves without a topic: a message waiting for its answer, or a running step's progress. */
const moving = (c: ItemChat | undefined) =>
  !!c?.conversations.some((v) => v.working || v.entries.some((e) => (e.t === "said" && e.pending) || (e.t === "work" && e.state === "running")));
/** Queued work, whose reason changes slowly: read less often. */
const queued = (c: ItemChat | undefined) => !!c?.conversations.some((v) => v.queued.length > 0);

/** The chat read, asked `since` its last stamp. `keep` stores a read the send already returned, so the next read is small. */
function useChat(repo: string, number: number) {
  const key = `item-chat:${repo}#${number}`;
  const last = useRef<{ key: string; chat: ItemChat } | null>(null);
  const q = useQuery<ItemChat>(
    key,
    async (a) => {
      const prev = last.current?.key === key ? last.current.chat : null;
      const r = await a.itemChat.get(repo, number, prev?.stamp);
      if ("unchanged" in r && prev) return prev;
      if ("unchanged" in r) throw new Error("unexpected empty answer");
      last.current = { key, chat: r };
      return r;
    },
    { pollMs: (c) => (moving(c) ? 4000 : queued(c) ? 20_000 : false) },
  );
  const keep = useCallback((chat: ItemChat) => void (last.current = { key, chat }), [key]);
  return { ...q, keep };
}

export function ItemView(props: ViewProps) {
  const repo = props.params.repo!;
  const number = Number(props.params.number);
  const { data: m, error } = useQuery(`maintain-item:${repo}#${number}`, (a) => a.maintainItem.get(repo, number));
  if (!m || m.repo !== repo || m.number !== number) return <Pending error={error} />;
  return <ItemPage m={m} login={props.user.login} />;
}

/**
 * Which side view shows and whether it is open. The URL wins; without `tab`, wide screens keep the reader's last view and
 * open state, and phones show the chat. `focusKey` counts requests to show an event, so the same one can be asked for again.
 */
function useSide(login: string, phone: boolean) {
  const [params, setParams] = useSearchParams();
  const dock = useDockState<Side>(login, DOCK, SIDES);
  const event = params.get("event");
  const tab = SIDES.find((x) => x.value === params.get("tab"))?.value ?? (event ? "events" : null);
  const view = tab ?? dock.view;
  const open = phone ? !!tab : tab ? true : dock.open;
  const [focusKey, setFocusKey] = useState(0);
  const setUrl = useCallback(
    (next: Side | null, ev?: string) =>
      setParams(
        (p) => {
          const n = new URLSearchParams(p);
          if (next) n.set("tab", next);
          else n.delete("tab");
          if (ev) n.set("event", ev);
          else n.delete("event");
          return n;
        },
        { replace: true },
      ),
    [setParams],
  );
  const onView = (v: Side) => {
    dock.setView(v);
    if (phone || tab) setUrl(v);
  };
  const onOpen = (o: boolean) => {
    if (!phone) dock.setOpen(o);
    if (!o) setUrl(null);
  };
  /** From a chat row or a badge: open `v`, on event `ev` when given. */
  const show = (v: Side, ev?: string) => {
    dock.setView(v);
    if (!phone) dock.setOpen(true);
    setUrl(v, ev);
    setFocusKey((k) => k + 1);
  };
  return { view, open, event: view === "events" ? event : null, focusKey, onView, onOpen, show };
}

function ItemPage({ m, login }: { m: MaintainItem; login: string }) {
  const api = useApi();
  const phone = useIsPhone();
  const { data: d, error } = usePage(m.repo, m.number);
  const chat = useChat(m.repo, m.number);
  const side = useSide(login, phone);
  // A chat row or a badge that opens a view moves focus to that view's tab; an event focuses its own row (History).
  const focusTab = useRef<Side | null>(null);
  useEffect(() => {
    const v = focusTab.current;
    if (!v || !side.open || side.view !== v) return;
    focusTab.current = null;
    document.getElementById(`${DOCK}-${phone ? "phone" : "side"}-tab-${v}`)?.focus();
  }, [side.open, side.view, side.focusKey, phone]);
  const show = (v: Side, ev?: string) => {
    focusTab.current = ev ? null : v;
    side.show(v, ev);
  };
  if (!d || d.repo !== m.repo || d.number !== m.number) return <Pending error={error} />;

  const conv = chat.data?.conversations[0];
  const send = async (text: string) => {
    if (!conv) return [];
    const r = await api.itemChat.send(m.repo, m.number, conv.id, text);
    chat.keep(r.chat);
    chat.refetch();
    return r.lines;
  };
  const withdraw = async () => {
    chat.keep(await api.itemChat.withdraw(m.repo, m.number));
    chat.refetch();
  };
  const status = chat.data?.status || m.status?.headline || null;
  const fallback = (x: NonNullable<MaintainItem["status"]>): ItemChatState => (x.held ? "held" : x.asked || x.rec || x.unclear ? "waiting" : x.live ? "running" : "idle");
  const state: ItemChatState = chat.data?.status ? chat.data.state : m.status ? fallback(m.status) : "idle";
  const header = (
    <Header
      m={m}
      d={d}
      status={status}
      state={state}
      next={chat.data?.status ? chat.data.next : null}
      onDuplicates={() => show("events")}
      toggle={
        !phone && (
          <button
            type="button"
            aria-expanded={side.open}
            aria-label={t("Side panel")}
            title={side.open ? t("Close side panel") : t("Show side panel")}
            onClick={() => side.onOpen(!side.open)}
            className={cn(
              "inline-flex size-11 shrink-0 items-center justify-center rounded-md border border-line-strong text-ink/80 transition-colors duration-fast hover:bg-ink/[0.06] hover:text-ink",
              side.open ? "bg-ink/[0.07] text-ink" : "bg-raised",
            )}
          >
            <SidebarSimpleIcon aria-hidden className="-scale-x-100 text-[18px]" />
          </button>
        )
      }
    />
  );
  const main = (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      {!phone && header}
      {!chat.data ? (
        <div className="flex-1">
          <Pending error={chat.error} />
        </div>
      ) : conv ? (
        <ItemConversation c={conv} onSend={send} onWithdraw={withdraw} onEvent={(id) => show("events", id)} onGithub={() => show("github")} notice={<Controls m={m} />} />
      ) : (
        <div className="flex flex-1 flex-col">
          <div className="flex flex-1 items-center justify-center px-4">
            <EmptyState icon={ChatsIcon}>{t("No conversation yet.")}</EmptyState>
          </div>
          <Controls m={m} />
        </div>
      )}
    </div>
  );
  const views: DockView<Side>[] = [
    { value: "github", label: "GitHub", defaultSize: 46, count: d.github.events.length, content: <GithubSide d={d} /> },
    {
      value: "events",
      label: t("Events"),
      defaultSize: 34,
      content: (
        <div className="flex flex-col gap-3 px-3 pb-8 pt-3">
          <Duplicates m={m} />
          <History repo={m.repo} number={m.number} kind={m.kind} said={m.events} focus={side.event} focusKey={side.focusKey} />
        </div>
      ),
    },
  ];
  return (
    <SideDock
      id={DOCK}
      login={login}
      header={phone ? header : undefined}
      main={main}
      mainLabel={t("Chat")}
      views={views}
      view={side.view}
      onView={side.onView}
      open={side.open}
      onOpen={side.onOpen}
    />
  );
}

const KIND_STATE: Record<ItemKind, Record<ItemState, [PhosphorIcon, Tone, string]>> = {
  pr: { open: [GitPullRequestIcon, "ok", tk("Open PR")], merged: [GitMergeIcon, "merged", tk("Merged PR")], closed: [GitPullRequestIcon, "bad", tk("Closed PR")] },
  issue: { open: [RadioButtonIcon, "ok", tk("Open issue")], closed: [CheckCircleIcon, "merged", tk("Closed issue")], merged: [CheckCircleIcon, "merged", tk("Closed issue")] },
};

const STATUS_LOOK: Record<ItemChatState, [PhosphorIcon, string, "fill" | "bold" | "regular"]> = {
  running: [CircleNotchIcon, "text-accent-ink animate-spin", "bold"],
  waiting: [ChatCircleDotsIcon, "text-warn", "fill"],
  held: [PauseCircleIcon, "text-ink/70", "fill"],
  done: [CheckCircleIcon, "text-ok", "fill"],
  idle: [CircleIcon, "text-ink/60", "regular"],
};
const STATE_WORD: Record<ItemChatState, string> = { running: tk("running"), waiting: tk("waiting"), held: tk("held"), done: tk("done"), idle: tk("not started") };

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;
const SEVERITY_TONE = { critical: "bad", high: "bad", medium: "warn", low: "neutral" } as const;
/** Badges that are links or buttons reach 44 px tall for touch without growing the row. */
const HIT = "relative rounded-full after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink";

function Header({ m, d, status, state, next, onDuplicates, toggle }: { m: MaintainItem; d: ItemPageData; status: string | null; state: ItemChatState; next: string | null; onDuplicates: () => void; toggle: ReactNode }) {
  const weight = m.status?.live ? m.status.weight : null;
  const [KindIcon, tone, kindLabel] = KIND_STATE[d.kind][d.state];
  const [StatusIcon, statusTone, statusWeight] = STATUS_LOOK[state];
  const worst = [...m.security].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])[0];
  return (
    <header className="shrink-0 border-b border-line bg-panel">
      <div className="mx-auto w-full max-w-[784px] px-4 pb-2.5 pt-1 md:px-8 md:pb-4 md:pt-3">
        <div className="flex items-center gap-2">
          <Link to="/items" aria-label={t("Back to Items")} title={t("Items")} className="-ml-3 inline-flex size-11 shrink-0 items-center justify-center rounded-md text-ink/70 hover:bg-ink/[0.06] hover:text-ink">
            <ArrowLeftIcon aria-hidden className="text-[16px]" />
          </Link>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="flex max-w-full min-w-0 items-center gap-2.5">
              <span className="code min-w-0 truncate text-sm text-ink/70" title={`${d.repo}#${d.number}`}>
                {d.repo}#{d.number}
              </span>
              <Badge tone={tone} icon={<KindIcon aria-hidden weight="bold" />}>
                {t(kindLabel)}
              </Badge>
            </span>
            {weight && <Badge tone={weight === "urgent" ? "bad" : weight === "low" ? "neutral" : "warn"}>{weight}</Badge>}
            {m.duplicates.length > 0 && (
              <button type="button" onClick={onDuplicates} className={HIT}>
                <Badge tone="warn">{m.duplicates.length === 1 ? t("1 duplicate") : t("{n} duplicates", { n: m.duplicates.length })}</Badge>
              </button>
            )}
            {m.outside && <Badge tone="warn">{t("Held: outside author")}</Badge>}
            {worst && (
              <Link to={`/security/${encodeURIComponent(m.repo)}/${worst.number}`} className={HIT}>
                <Badge tone={SEVERITY_TONE[worst.severity]} icon={<ShieldWarningIcon aria-hidden weight="bold" />}>
                  {m.security.length === 1 ? t("Security: {severity}", { severity: worst.severity }) : t("{n} security findings", { n: m.security.length })}
                </Badge>
              </Link>
            )}
          </div>
          <GithubLinkButton href={d.github.url} />
          {toggle}
        </div>
        <h1 className="mt-0.5 line-clamp-2 break-words text-lg font-semibold leading-6 tracking-[-0.01em] md:line-clamp-none md:text-xl md:leading-7">{d.title}</h1>
        {status && (
          <p className="mt-1 flex items-start gap-2 text-sm md:mt-1.5">
            <span className="inline-flex h-5 shrink-0 items-center">
              <StatusIcon aria-hidden weight={statusWeight} className={cn("text-[14px]", statusTone)} />
            </span>
            <span className="sr-only">{t(STATE_WORD[state])}: </span>
            <span title={next ? `${status}. ${t("Next: {step}", { step: next })}` : status} className="line-clamp-2 min-w-0">
              <span className="font-medium text-ink">{status}</span>
              {next && <span className="text-ink/70">. {t("Next: {step}", { step: next })}</span>}
            </span>
          </p>
        )}
        {m.status?.notPosted && <p className="mt-1.5 rounded border border-warn/60 bg-warn/10 px-3 py-1.5 text-sm">{m.status.notPosted}</p>}
      </div>
    </header>
  );
}

/** The item's duplicates, at the top of Events; the header badge opens them. */
function Duplicates({ m }: { m: MaintainItem }) {
  if (!m.duplicates.length) return null;
  return (
    <section aria-labelledby="item-duplicates" className="rounded-lg border border-line bg-panel px-3 py-2.5">
      <h2 id="item-duplicates" className="mb-1.5 text-xs font-semibold text-ink/70">
        {t("Duplicates")}
      </h2>
      <ul className="flex flex-col gap-2">
        {m.duplicates.map((x) => (
          <li key={`${x.repo}#${x.number}`} className="relative flex flex-col gap-0.5 text-sm">
            <ItemRef repo={x.repo} number={x.number} kind={x.kind} state={x.state} title={x.title} stretch />
            {x.canonical && <span className="pl-6 text-xs text-ink/70">{t("kept as the main item")}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Release from an outside-author hold and resume a breaker: registered controls, as rows above the composer. */
function Controls({ m }: { m: MaintainItem }) {
  const api = useApi();
  const [reply, setReply] = useState<MaintainReply | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (id: string, body: Parameters<typeof api.maintainItem.control>[0]) => {
    setBusy(id);
    try {
      setReply(await api.maintainItem.control(body));
    } catch (e) {
      setReply({ ok: false, lines: [e instanceof Error ? e.message : String(e)] });
    } finally {
      setBusy(null);
    }
  };
  const rows = [
    ...(m.outside
      ? [
          {
            id: "outside",
            line:
              m.outside.reason === "surge"
                ? t("Held: {author} is outside the team and opened this during a surge.", { author: m.outside.author })
                : t("Held: {author} is outside the team and over the daily limit.", { author: m.outside.author }),
            action: m.outside.canRelease ? { label: t("Release"), go: () => run("outside", { control: "release-outside", repo: m.repo, number: m.number }) } : null,
          },
        ]
      : []),
    ...m.breakers.map((b) => ({
      id: b.key,
      line: b.reason ? t("Paused by the {key} breaker: {reason}", { key: b.key, reason: b.reason }) : t("Paused by the {key} breaker", { key: b.key }),
      action: b.canResume ? { label: t("Resume"), go: () => run(b.key, { control: "resume-breaker", key: b.key }) } : null,
    })),
  ];
  if (!rows.length && !reply) return null;
  return (
    <div className="mx-auto w-full max-w-[784px] px-3 md:px-6">
      {rows.length > 0 && (
        <ul aria-label={t("Holds")} className="mb-2 flex flex-col gap-1.5">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-warn/60 bg-warn/10 px-3 py-2 text-sm">
              <PauseCircleIcon aria-hidden weight="fill" className="shrink-0 text-warn" />
              <span className="min-w-0 flex-1">{r.line}</span>
              {r.action && (
                <Button size="lg" loading={busy === r.id} onClick={() => void r.action!.go()}>
                  {r.action.label}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div aria-live="polite">
        {reply?.lines.map((l) => (
          <p key={l} className={cn("mb-2 text-sm", reply.ok ? "text-ink/80" : "text-bad")}>
            {l}
          </p>
        ))}
      </div>
    </div>
  );
}
