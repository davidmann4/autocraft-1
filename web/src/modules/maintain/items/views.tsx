// Items: a browser over every item of the visible repos. One search box takes words and qualifiers (src/core/item-query.ts),
// kept in the URL as `q`; the views row sets the whole query, the quick filters change one qualifier each. The server filters,
// sorts and pages. People who may send commands tick items to fill the command box with the list form (`merge:` then one item
// per line) and run it for all of them at once.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ChatCircleIcon, CheckCircleIcon, CircleDashedIcon, DiscordLogoIcon, FunnelIcon, GitPullRequestIcon, RadioButtonIcon, TerminalIcon, XCircleIcon } from "@phosphor-icons/react";
import { t } from "../../../../../src/i18n/index.ts";
import { AUTOCRAFT_STATES, DEFAULT_QUERY, KINDS, PRESETS, PRIORITIES, parseItemQuery, presetOf, splitWords, termValues, withTerm, type QueryKey } from "../../../../../src/core/item-query.ts";
import { useApi, useQuery } from "../../../api/client";
import { usePageProject } from "../../../api/scope";
import type { BrowseAutocraft, BrowseRow, MaintainCommandResult } from "../../../api/types";
import { itemPath } from "../../../lib/links";
import { num } from "../../../lib/format";
import { useUser } from "../../../shell/UserContext";
import { Badge, type Tone } from "../../../ui/atoms/Badge";
import { Button } from "../../../ui/atoms/Button";
import { Chip } from "../../../ui/atoms/Chip";
import { Pending } from "../../../ui/atoms/Pending";
import { Select } from "../../../ui/atoms/Select";
import { Textarea } from "../../../ui/atoms/Textarea";
import { TimeAgo } from "../../../ui/atoms/TimeAgo";
import { Dialog } from "../../../ui/molecules/Dialog";
import { ItemRef } from "../../../ui/molecules/ItemRef";
import { Pager } from "../../../ui/molecules/Pager";
import { SearchField } from "../../../ui/molecules/SearchField";
import { Segmented } from "../../../ui/molecules/Segmented";
import { cn } from "../../../ui/cn";
import type { ViewProps } from "../../../registry/types";

const PAGE = 50;
/** Labels a phone row shows before "+n". */
const PHONE_LABELS = 2;
const refOf = (r: { repo: string; number: number }) => `${r.repo}#${r.number}`;

/** The command box text with `refs` as its item list: the words before the colon stay, the list after it is replaced. */
export function withItems(text: string, refs: string[]): string {
  const colon = text.indexOf(":");
  const head = (colon >= 0 ? text.slice(0, colon) : text).trimEnd();
  return refs.length ? `${head}:\n${refs.join("\n")}` : head;
}

/** Links from before the search box (`filter=`, `show=`, `discord=1`, `area=`) as a query; null when the URL has none of them. */
function legacyQuery(p: URLSearchParams): string | null {
  const show = p.get("show");
  const parts = [show === "closed" ? "is:closed" : show === "merged" ? "is:merged" : show === "backlog" ? "autocraft:backlog" : "is:open"];
  const flags: Record<string, string> = { mine: "is:mine", outside: "is:outside-held", duplicates: "is:duplicate", security: "is:security", stuck: "is:stuck" };
  for (const f of (p.get("filter") ?? "").split(",")) if (flags[f]) parts.push(flags[f]!);
  if (p.get("discord") === "1") parts.push("discord:mentioned");
  if (p.get("area")) parts.push(`area:${p.get("area")}`);
  if (p.get("sort") === "priority") parts.push("sort:priority");
  // `is:mine` lists done items too, as Home's own items do.
  if (parts.includes("is:mine") && !show) parts.shift();
  return parts.length > 1 || show || parts[0] === "is:mine" ? parts.join(" ") : null;
}

/** The query and page in the URL, written readably: `?q=is:open+label:bug`. */
function useBrowseUrl() {
  const loc = useLocation();
  const navigate = useNavigate();
  const params = useMemo(() => new URLSearchParams(loc.search), [loc.search]);
  const q = params.get("q") ?? legacyQuery(params) ?? DEFAULT_QUERY;
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const meaning = params.get("by") === "meaning";
  const go = (next: { q?: string; offset?: number; meaning?: boolean }) => {
    const nq = (next.q ?? q).trim();
    const nm = next.meaning ?? meaning;
    const no = (next.q !== undefined && nq !== q) || nm !== meaning ? 0 : next.offset ?? offset;
    const enc = encodeURIComponent(nq).replace(/%20/g, "+").replace(/%3A/gi, ":").replace(/%2C/gi, ",");
    const search = [nq === DEFAULT_QUERY ? "" : `q=${enc}`, nm ? "by=meaning" : "", no ? `offset=${no}` : ""].filter(Boolean).join("&");
    navigate({ pathname: loc.pathname, search: search ? `?${search}` : "" });
  };
  return { q, offset, meaning, go };
}

const AUTOCRAFT_WORD: Record<BrowseAutocraft, { label: string; tone: Tone } | null> = {
  running: { label: "Working", tone: "accent" },
  waiting: { label: "Waiting", tone: "warn" },
  stopped: { label: "Stopped by the rule", tone: "neutral" },
  held: { label: "Held", tone: "neutral" },
  backlog: { label: "Backlog", tone: "neutral" },
  done: { label: "Done", tone: "ok" },
  none: null,
};
const AUTOCRAFT_TITLE: Record<BrowseAutocraft, string> = {
  running: "AutoCraft is working on it", waiting: "AutoCraft waits for a person", stopped: "Stopped by the automatic merge rule; a maintainer's yes takes it over", held: "Held", backlog: "In the Backlog", done: "AutoCraft is done with it", none: "Not started",
};
const priorityTone = (p: string): Tone => (p === "P0" ? "bad" : p === "P1" ? "warn" : "neutral");

function Ci({ ci }: { ci: BrowseRow["ci"] }) {
  if (!ci) return null;
  const [Icon, cls, label] = ci === "green" ? [CheckCircleIcon, "text-ok", t("CI passed")] : ci === "red" ? [XCircleIcon, "text-bad", t("CI failed")] : [CircleDashedIcon, "text-warn", t("CI running")];
  return (
    <span role="img" aria-label={label} title={label} className={cn("relative z-10 inline-flex items-center", cls)}>
      <Icon weight="bold" />
    </span>
  );
}

/** Counts and links after the title: CI, comments, Discord mentions and the linked item. */
function Meta({ r }: { r: BrowseRow }) {
  return (
    <>
      <Ci ci={r.ci} />
      {r.comments + r.reactions > 0 && (
        <span className="relative z-10 inline-flex items-center gap-1" title={t("{c} comments, {r} reactions", { c: r.comments, r: r.reactions })}>
          <ChatCircleIcon aria-hidden />
          <span className="num">{r.comments}</span>
          <span className="sr-only">{t("comments")}</span>
        </span>
      )}
      {r.discord > 0 && (
        <span className="relative z-10 inline-flex items-center gap-1" title={t("{n} mentions on Discord", { n: r.discord })}>
          <DiscordLogoIcon aria-hidden />
          <span className="num">{r.discord}</span>
          <span className="sr-only">{t("mentions on Discord")}</span>
        </span>
      )}
      {r.linked !== null && (
        <Link
          to={itemPath(r.repo, r.linked)}
          className="relative z-10 inline-flex items-center gap-0.5 hover:underline"
          aria-label={r.kind === "pr" ? t("Closes #{n}", { n: r.linked }) : t("Pull request #{n}", { n: r.linked })}
        >
          {r.kind === "pr" ? <RadioButtonIcon aria-hidden /> : <GitPullRequestIcon aria-hidden />}
          <span className="num">#{r.linked}</span>
        </Link>
      )}
    </>
  );
}

function Row({ r, opened, picking, picked, may, onPick }: { r: BrowseRow; opened: boolean; picking: boolean; picked: boolean; may: boolean; onPick: (on: boolean) => void }) {
  const word = AUTOCRAFT_WORD[r.autocraft];
  return (
    <li className="relative flex items-start gap-2 px-3 py-2 hover:bg-ink/[0.025]" data-row>
      {picking && (
        <label className="relative z-10 -my-2 -ml-2 flex size-11 shrink-0 cursor-pointer items-center justify-center md:-my-1 md:size-8">
          <input type="checkbox" className="size-4 accent-accent" checked={picked} disabled={!may} onChange={(e) => onPick(e.target.checked)} aria-label={t("Select {ref}", { ref: refOf(r) })} />
        </label>
      )}
      <div className="min-w-0 flex-1">
        <ItemRef repo={r.repo} number={r.number} kind={r.kind} state={r.state} draft={r.draft} title={r.title} stretch />
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-xs text-ink/70">
          {r.asksYou && <Badge tone="accent">{t("Asks you")}</Badge>}
          {word && (
            <span title={t(AUTOCRAFT_TITLE[r.autocraft])} className="relative z-10">
              <Badge tone={word.tone}>{t(word.label)}</Badge>
            </span>
          )}
          {r.priority && <Badge tone={priorityTone(r.priority)}>{r.priority}</Badge>}
          {r.duplicate && <Badge tone="warn">{t("Duplicate")}</Badge>}
          {r.labels.map((l, i) => (
            <span key={l} className={cn("inline-flex h-5 max-w-[16rem] items-center truncate rounded-full border border-line-strong px-2 text-2xs text-ink/80", i >= PHONE_LABELS && "max-md:hidden")}>
              {l}
            </span>
          ))}
          {r.labels.length > PHONE_LABELS && <span className="md:hidden">+{r.labels.length - PHONE_LABELS}</span>}
          {r.classified && (
            <span className="relative z-10 max-md:hidden" title={t("Classified by AutoCraft")}>
              {KINDS[r.classified] ?? r.classified}
            </span>
          )}
          {r.size && <span className="max-md:hidden">{t("size {s}", { s: r.size })}</span>}
          {r.area && <span className="max-md:hidden">{r.area}</span>}
          <span className="flex items-center gap-2 md:hidden">
            <Meta r={r} />
          </span>
          <span className="ml-auto flex items-center gap-1 whitespace-nowrap">
            {r.author && (
              <span>
                {r.author}
                {r.outside && <span> ({t("outside")})</span>}
              </span>
            )}
            <span aria-hidden>·</span>
            {opened && <span>{t("opened")}</span>}
            <TimeAgo iso={opened ? r.createdAt : r.updatedAt} className="relative z-10" />
          </span>
        </div>
      </div>
      <div className="hidden w-36 shrink-0 items-center justify-end gap-3 pt-0.5 text-xs text-ink/70 md:flex">
        <Meta r={r} />
      </div>
    </li>
  );
}

/** One quick filter: a select over the values of one qualifier; the empty value removes it. With `prefix` a value reads "Label: bug". */
function QuickSelect({ label, value, options, onChange, prefix }: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void; prefix?: boolean }) {
  return (
    <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="w-full md:w-auto md:max-w-[13rem]">
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {prefix && v ? t("{label}: {value}", { label, value: l }) : l}
        </option>
      ))}
    </Select>
  );
}

const SORT_OPTIONS: [string, string][] = [
  ["updated", "Recently updated"], ["created", "Newest"], ["created-asc", "Oldest"], ["comments", "Most discussed"], ["priority", "Priority"], ["discord", "Discord mentions"],
];

/** The quick filters over the query's qualifiers; each change rewrites one qualifier of `q`. */
function QuickFilters({ q, set, facets, repos, meaning }: { q: string; set: (q: string) => void; facets: { labels: string[]; authors: string[]; areas: string[] } | null; repos: string[] | null; meaning: boolean }) {
  const one = (key: QueryKey) => termValues(q, key)[0] ?? "";
  const setOne = (key: QueryKey) => (v: string) => set(withTerm(q, key, v ? [v] : []));
  const parsed = parseItemQuery(q);
  const sort = `${parsed.sort.by}${parsed.sort.asc ? "-asc" : ""}`;
  // A value typed in the box that the lists do not hold still shows as picked.
  const withCurrent = (vs: string[], cur: string) => (cur && !vs.includes(cur) ? [cur, ...vs] : vs);
  const pairs = (vs: string[]) => vs.map((v): [string, string] => [v, v]);
  const states = termValues(q, "state");
  const area = one("area");
  return (
    <>
      {repos && <QuickSelect label={t("Repository")} value={one("repo")} onChange={setOne("repo")} options={[["", t("All repositories")], ...pairs(withCurrent(repos, one("repo")))]} />}
      <QuickSelect label={t("Type")} value={one("type")} onChange={setOne("type")} options={[["", t("Issues and PRs")], ["issue", t("Issues")], ["pr", t("Pull requests")]]} />
      <QuickSelect label={t("State")} value={states.length === 1 ? states[0]! : ""} onChange={setOne("state")} options={[["", t("Any state")], ["open", t("Open")], ["closed", t("Closed")], ["merged", t("Merged")]]} />
      <QuickSelect label={t("Label")} prefix value={one("label")} onChange={setOne("label")} options={[["", t("Any label")], ...pairs(withCurrent(facets?.labels ?? [], one("label")))]} />
      <QuickSelect label={t("Priority")} prefix value={one("priority")} onChange={setOne("priority")} options={[["", t("Any priority")], ...pairs([...PRIORITIES])]} />
      <QuickSelect label={t("Area")} prefix value={area} onChange={setOne("area")} options={[["", t("Any area")], ...pairs(withCurrent(facets?.areas ?? [], area === "none" ? "" : area)), ["none", t("No area")]]} />
      <QuickSelect label={t("Author")} prefix value={one("author")} onChange={setOne("author")} options={[["", t("Any author")], ...pairs(withCurrent(facets?.authors ?? [], one("author")))]} />
      <QuickSelect
        label={t("AutoCraft")}
        value={one("autocraft")}
        onChange={setOne("autocraft")}
        options={[["", t("Any AutoCraft state")], ...AUTOCRAFT_STATES.map((s): [string, string] => [s, s === "none" ? t("Not started") : t(AUTOCRAFT_WORD[s]!.label)])]}
      />
      <QuickSelect label={t("Discord")} value={one("discord")} onChange={setOne("discord")} options={[["", t("Discord: any")], ["mentioned", t("Mentioned on Discord")]]} />
      {/* Hits by meaning come best first: no sort applies. */}
      {!meaning && <QuickSelect label={t("Sort")} prefix value={sort} onChange={(v) => set(withTerm(q, "sort", v === "updated" ? [] : [v]))} options={SORT_OPTIONS.map(([v, l]): [string, string] => [v, t(l)])} />}
    </>
  );
}

/** The command box: free text in the same words as on GitHub and Discord; the reply lines show what ran and what was unclear. */
function CommandBox({ text, setText, onDone }: { text: string; setText: (s: string) => void; onDone: (r: MaintainCommandResult) => void }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MaintainCommandResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.maintain.command(text);
      setResult(r);
      onDone(r);
    } catch (e) {
      setResult(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label={t("Command")} className="flex flex-col gap-2 rounded-lg border border-line-strong bg-raised p-3">
      <label htmlFor="items-command" className="text-sm font-medium">
        {t("Command")}
      </label>
      <Textarea
        id="items-command"
        value={text}
        rows={Math.min(8, Math.max(3, text.split("\n").length + 1))}
        placeholder={"merge:\nphotocraft#123\nphotocraft#456"}
        onChange={(e) => setText(e.target.value)}
        // A list filled from the ticks starts with its colon: the words go in front of it.
        onFocus={(e) => text.startsWith(":") && e.currentTarget.setSelectionRange(0, 0)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void run();
          }
        }}
        className="code text-sm"
      />
      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={() => void run()} loading={busy} disabled={!text.trim()} className="max-md:h-11">
          {t("Run")}
        </Button>
      </div>
      <div aria-live="polite" className="flex flex-col gap-1 empty:hidden">
        {error && <p className="text-sm text-bad">{error}</p>}
        {result?.lines.map((l, i) => (
          <p key={i} className={cn("text-sm", result.items.length && result.items.every((x) => x.outcome === "run") ? "text-ink/80" : "text-warn")}>
            {l}
          </p>
        ))}
      </div>
    </section>
  );
}

/** Arrow keys, j/k, Home and End move the focus between the rows' item links. */
function onListKey(e: KeyboardEvent<HTMLUListElement>) {
  const target = e.target as HTMLElement;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
  // Each row's first link is its item link (ItemRef).
  const links = [...e.currentTarget.querySelectorAll<HTMLLIElement>("li[data-row]")].flatMap((li) => li.querySelector("a") ?? []);
  const at = links.findIndex((a) => a.closest("li")?.contains(document.activeElement));
  const to = e.key === "ArrowDown" || e.key === "j" ? at + 1 : e.key === "ArrowUp" || e.key === "k" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? links.length - 1 : null;
  if (to === null || !links.length) return;
  e.preventDefault();
  links[Math.max(0, Math.min(links.length - 1, to))]!.focus();
}

export function ItemsView(_: ViewProps) {
  const user = useUser();
  const project = usePageProject();
  const url = useBrowseUrl();
  const [typed, setTyped] = useState(url.q);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmd, setCmd] = useState("");
  const [sheet, setSheet] = useState(false);
  const filtersButton = useRef<HTMLButtonElement>(null);
  const activeChip = useRef<HTMLButtonElement>(null);
  const writes = user.role !== "viewer" && user.runRepos.length > 0;

  useEffect(() => setTyped(url.q), [url.q]);
  // On phones the views scroll sideways: the picked one stays in sight.
  useEffect(() => activeChip.current?.scrollIntoView({ block: "nearest", inline: "center" }), [url.q]);

  // A search by meaning embeds the words; the qualifiers still filter its hits, which keep their order.
  const split = url.meaning ? splitWords(url.q) : null;
  const { data, error } = useQuery(`maintain-browse:${url.q}:${url.offset}:${url.meaning}`, async (a) => {
    if (!split?.words) return a.maintain.browse({ q: url.q, offset: url.offset, limit: PAGE });
    const hits = await a.semanticSearch(split.words);
    if (!hits.length) return { rows: [], total: 0, offset: 0, limit: PAGE, unknown: [], presets: null, facets: null };
    return a.maintain.browse({ q: split.rest, refs: hits.map(refOf), offset: url.offset, limit: PAGE });
  });
  const { data: counts } = useQuery("maintain-browse:presets", (a) => a.maintain.browse({ q: "", limit: 1, presets: true }));
  const { data: repoList } = useQuery("maintain-browse:repos", (a) => a.repos(), { enabled: !project });
  const preset = presetOf(url.q);
  // Sorted by when they were opened, rows show that time instead of the last update.
  const byCreated = parseItemQuery(url.q).sort.by === "created";
  const set = (q: string) => url.go({ q });

  const pick = (refs: string[], on: boolean) => {
    const next = new Set(picked);
    for (const r of refs) if (on) next.add(r); else next.delete(r);
    setPicked(next);
    setCmd(withItems(cmd, [...next]));
    if (next.size) setCmdOpen(true);
  };
  const done = (r: MaintainCommandResult) => {
    if (r.items.length && r.items.every((x) => x.outcome === "run")) {
      setPicked(new Set());
      setCmd("");
    }
  };

  const filters = <QuickFilters q={url.q} set={set} facets={counts?.facets ?? null} repos={project ? null : repoList ?? []} meaning={!!split?.words} />;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-3 px-4 pb-10 pt-5 md:px-6">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-xl font-semibold">{t("Items")}</h1>
          {writes && (
            <Button icon={TerminalIcon} aria-expanded={cmdOpen} onClick={() => setCmdOpen(!cmdOpen)} className="max-md:h-11">
              {picked.size ? t("Command ({n} selected)", { n: picked.size }) : t("Command")}
            </Button>
          )}
        </div>
        {writes && cmdOpen && <CommandBox text={cmd} setText={setCmd} onDone={done} />}

        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <SearchField value={typed} onChange={setTyped} onSubmit={(v) => set(v)} label={t("Search items")} placeholder={t("Words, or is:open label:bug author:name")} />
          </div>
          <Segmented
            label={t("Search by")}
            value={url.meaning ? "meaning" : "words"}
            onChange={(v) => url.go({ meaning: v === "meaning" })}
            options={[{ value: "words", label: t("Words") }, { value: "meaning", label: t("Meaning") }]}
            className="hidden shrink-0 flex-nowrap md:flex"
          />
          <Button ref={filtersButton} icon={FunnelIcon} onClick={() => setSheet(true)} className="h-11 md:hidden" aria-haspopup="dialog">
            {t("Filters")}
          </Button>
        </div>

        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0" role="group" aria-label={t("Views")}>
          {PRESETS.map((p) => (
            <Chip key={p.id} ref={preset?.id === p.id ? activeChip : undefined} active={preset?.id === p.id} className="shrink-0 max-md:h-11" count={counts?.presets ? num(counts.presets[p.id] ?? 0) : undefined} onClick={() => set(p.query)}>
              {t(p.label)}
            </Chip>
          ))}
        </div>

        <div className="hidden flex-wrap gap-2 md:flex" role="group" aria-label={t("Filters")}>
          {filters}
        </div>
        <Dialog open={sheet} onClose={() => setSheet(false)} title={t("Filters")} variant="side" returnFocusRef={filtersButton}>
          <div className="flex flex-col gap-3">
            <Segmented
              label={t("Search by")}
              value={url.meaning ? "meaning" : "words"}
              onChange={(v) => url.go({ meaning: v === "meaning" })}
              options={[{ value: "words", label: t("Words") }, { value: "meaning", label: t("Meaning") }]}
              className="flex-nowrap"
            />
            {filters}
          </div>
          <Button variant="primary" className="mt-4 h-11 w-full" onClick={() => setSheet(false)}>
            {data ? t("Show {n} items", { n: num(data.total) }) : t("Done")}
          </Button>
        </Dialog>

        {data && data.unknown.length > 0 && <p className="text-sm text-warn">{t("Not applied: {terms}", { terms: data.unknown.join(" ") })}</p>}
        <div className="flex min-h-8 items-center justify-between gap-2 text-sm text-ink/70">
          <span aria-live="polite" className="num">
            {data ? (data.total === 1 ? t("1 item") : t("{n} items", { n: num(data.total) })) : ""}
          </span>
          {!preset && (
            <Button variant="ghost" onClick={() => set(DEFAULT_QUERY)} className="max-md:h-11">
              {t("Clear search")}
            </Button>
          )}
        </div>

        {!data ? (
          <Pending error={error} />
        ) : data.rows.length === 0 ? (
          <div className="rounded-lg border border-line px-4 py-6 text-md">{t("No items match.")}</div>
        ) : (
          <div className="rounded-lg border border-line bg-panel">
            <ul className="divide-y divide-line" aria-label={preset ? t(preset.label) : t("Items")} onKeyDown={onListKey}>
              {data.rows.map((r) => (
                <Row key={refOf(r)} r={r} opened={byCreated} picking={writes && cmdOpen} picked={picked.has(refOf(r))} may={user.runRepos.includes(r.repo)} onPick={(on) => pick([refOf(r)], on)} />
              ))}
            </ul>
            <Pager offset={data.offset} limit={data.limit} total={data.total} onOffset={(o) => url.go({ offset: o })} />
          </div>
        )}
      </div>
    </div>
  );
}
