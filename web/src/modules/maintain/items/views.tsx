// Items: four lists of the open items (needs an answer, started, handled automatically, not started), or the Backlog, or the
// closed items. Filters and search live in the URL. People who may send commands tick items to fill the command box with the
// list form (`merge:` then one item per line) and run it for all of them at once.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { TerminalIcon } from "@phosphor-icons/react";
import { t } from "../../../../../src/i18n/index.ts";
import { useApi, useQuery } from "../../../api/client";
import { usePageProject } from "../../../api/scope";
import type { MaintainCommandResult, MaintainItemGroup, MaintainItemRow, MaintainItemsFilter, MaintainItemsQuery, MaintainItemsShow } from "../../../api/types";
import { itemPath } from "../../../lib/links";
import { useUser } from "../../../shell/UserContext";
import { Badge } from "../../../ui/atoms/Badge";
import { Button } from "../../../ui/atoms/Button";
import { Chip } from "../../../ui/atoms/Chip";
import { ItemIcon } from "../../../ui/atoms/ItemIcon";
import { Pending } from "../../../ui/atoms/Pending";
import { Select } from "../../../ui/atoms/Select";
import { Textarea } from "../../../ui/atoms/Textarea";
import { SearchField } from "../../../ui/molecules/SearchField";
import { Segmented } from "../../../ui/molecules/Segmented";
import { cn } from "../../../ui/cn";
import type { ViewProps } from "../../../registry/types";

const PAGE = 50;
const SEARCH_DELAY_MS = 350;
const refOf = (r: { repo: string; number: number }) => `${r.repo}#${r.number}`;

/** The command box text with `refs` as its item list: the words before the colon stay, the list after it is replaced. */
export function withItems(text: string, refs: string[]): string {
  const colon = text.indexOf(":");
  const head = (colon >= 0 ? text.slice(0, colon) : text).trimEnd();
  return refs.length ? `${head}:\n${refs.join("\n")}` : head;
}

function groupTitle(g: MaintainItemGroup, viewer: boolean): string {
  switch (g) {
    case "needs": return viewer ? t("Waiting for a maintainer") : t("Needs an answer");
    case "started": return t("Started");
    case "automatic": return t("Handled automatically");
    case "rest": return t("Not started");
    case "backlog": return t("Backlog");
    case "done": return t("Closed and merged");
  }
}

/** Who started it and whether it is approved for merge. */
function byLine(r: MaintainItemRow): string | null {
  if (!r.startedBy) return null;
  const started = t("started by {login}", { login: r.startedBy });
  if (r.stoppedBy) return t("{started}, stopped by {login}", { started, login: r.stoppedBy });
  return t("{started}, {approved}", { started, approved: r.approvedBy ? t("approved by {login}", { login: r.approvedBy }) : t("not approved") });
}

/** The row's one status line: the workflow's line, or the pipeline's status for an item nobody started. */
function RowLine({ r }: { r: MaintainItemRow }) {
  const by = byLine(r);
  return (
    <div className="mt-1 line-clamp-2 text-sm">
      {r.weight && (
        <Badge tone={r.weight === "urgent" ? "bad" : r.weight === "low" ? "neutral" : "warn"} className="mr-1.5">
          {r.weight}
        </Badge>
      )}
      {r.blocked && <span className="text-bad">{t("Blocker")} · </span>}
      {r.line !== null ? (
        <span className={r.group === "needs" ? "font-medium text-accent-ink" : "text-ink/80"}>{r.line}</span>
      ) : r.status ? (
        <span className="text-ink/80">
          <span className="font-medium">{r.status.phase}</span>
          {r.status.waiting && <span className="text-ink/70"> · {t("waiting for {what}", { what: r.status.waiting })}</span>}
        </span>
      ) : null}
      {by && <span className="text-ink/70"> · {by}</span>}
    </div>
  );
}

/** Duplicate, held for an outside author, stuck and the area, after the ref and author. */
function Signals({ r }: { r: MaintainItemRow }) {
  return (
    <>
      {r.duplicate && <Badge tone="warn" className="ml-1.5">{t("Duplicate")}</Badge>}
      {r.outside && <Badge tone="warn" className="ml-1.5">{t("Held (outside)")}</Badge>}
      {r.stuck && <Badge tone="bad" className="ml-1.5">{t("Stuck")}</Badge>}
      {r.area && <Badge className="ml-1.5">{r.area}</Badge>}
    </>
  );
}

function ItemRow({ r, picking, picked, onPick }: { r: MaintainItemRow; picking: boolean; picked: boolean; onPick: (on: boolean) => void }) {
  const ref = refOf(r);
  return (
    <li className="relative flex items-start gap-3 px-3 py-3 hover:bg-ink/[0.025]">
      {picking && (
        <label className="relative z-10 -my-2 -ml-2 flex size-11 shrink-0 cursor-pointer items-center justify-center md:-my-1 md:size-8">
          <input
            type="checkbox"
            className="size-4 accent-accent"
            checked={picked}
            disabled={!r.may}
            onChange={(e) => onPick(e.target.checked)}
            aria-label={t("Select {ref}", { ref })}
          />
        </label>
      )}
      <ItemIcon kind={r.kind} state={r.state} className="mt-0.5" tip={false} />
      <div className="min-w-0 flex-1">
        <Link to={itemPath(r.repo, r.number)} className="block rounded text-md font-medium leading-snug after:absolute after:inset-0 hover:underline">
          {r.title}
        </Link>
        <div className="mt-0.5 text-xs text-ink/70">
          <span className="code">{ref}</span>
          {r.author && <> · {r.author}</>}
          <Signals r={r} />
        </div>
        <RowLine r={r} />
      </div>
    </li>
  );
}

function Group({ group, rows, total, viewer, picking, picked, onPick, onMore }: {
  group: MaintainItemGroup; rows: MaintainItemRow[]; total: number; viewer: boolean; picking: boolean;
  picked: Set<string>; onPick: (refs: string[], on: boolean) => void; onMore: () => void;
}) {
  if (!rows.length) return null;
  const title = groupTitle(group, viewer);
  const mine = rows.filter((r) => r.may).map(refOf);
  const all = mine.length > 0 && mine.every((r) => picked.has(r));
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <div className="mt-2 flex min-h-8 items-center gap-2">
        {picking && mine.length > 0 && (
          <label className="-ml-1 flex size-11 shrink-0 cursor-pointer items-center justify-center md:size-8">
            <input type="checkbox" className="size-4 accent-accent" checked={all} onChange={(e) => onPick(mine, e.target.checked)} aria-label={t("Select all in {group}", { group: title })} />
          </label>
        )}
        <h2 className="text-sm font-semibold text-ink/70">
          {title} <span className="num font-normal">({total})</span>
        </h2>
      </div>
      <ul className="divide-y divide-line rounded-lg border border-line bg-panel">
        {rows.map((r) => (
          <ItemRow key={refOf(r)} r={r} picking={picking} picked={picked.has(refOf(r))} onPick={(on) => onPick([refOf(r)], on)} />
        ))}
      </ul>
      {total > rows.length && (
        <Button variant="ghost" onClick={onMore} className="self-start max-md:h-11">
          {t("Show more ({n} not shown)", { n: total - rows.length })}
        </Button>
      )}
    </section>
  );
}

/** The command box: free text in the same words as on GitHub and Discord; the reply lines show what ran and what was unclear. */
function CommandBox({ text, setText, onDone }: { text: string; setText: (s: string) => void; onDone: (r: MaintainCommandResult) => void }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MaintainCommandResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
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
        ref={box}
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

const SHOWS: MaintainItemsShow[] = ["open", "backlog", "closed"];
const FILTERS: MaintainItemsFilter[] = ["security", "outside", "stuck", "duplicates"];
const filterLabel = (f: MaintainItemsFilter): string =>
  f === "security" ? t("Security") : f === "outside" ? t("Held (outside)") : f === "stuck" ? t("Stuck") : t("Duplicates");

/** The page's state in the URL: show, sort, filter, area, q and by (words or meaning). */
function useItemsUrl() {
  const [params, setParams] = useSearchParams();
  const setAll = (changes: Record<string, string | null>) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      for (const [k, v] of Object.entries(changes)) {
        if (v) n.set(k, v);
        else n.delete(k);
      }
      return n;
    }, { replace: true });
  const set = (k: string, v: string | null) => setAll({ [k]: v });
  const show = (SHOWS as string[]).includes(params.get("show") ?? "") ? (params.get("show") as MaintainItemsShow) : "open";
  const filters = (params.get("filter")?.split(",") ?? []).filter((f): f is MaintainItemsFilter => (FILTERS as string[]).includes(f));
  return {
    show, filters,
    sort: params.get("sort") === "updated" ? ("updated" as const) : ("priority" as const),
    area: params.get("area") ?? "",
    q: params.get("q") ?? "",
    meaning: params.get("by") === "meaning",
    set, setAll,
  };
}

export function ItemsView(_: ViewProps) {
  const user = useUser();
  const viewer = user.role === "viewer";
  const project = usePageProject();
  const url = useItemsUrl();
  const [typed, setTyped] = useState(url.q);
  const [limit, setLimit] = useState(PAGE);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmd, setCmd] = useState("");
  const writes = !viewer && user.runRepos.length > 0;

  // The URL follows the typing after a pause; a search by meaning embeds the text, so it waits the same.
  useEffect(() => {
    if (typed === url.q) return;
    const id = setTimeout(() => url.set("q", typed.trim() || null), SEARCH_DELAY_MS);
    return () => clearTimeout(id);
  }, [typed]); // eslint-disable-line react-hooks/exhaustive-deps

  const query: MaintainItemsQuery = useMemo(() => ({
    show: url.show, sort: url.sort, filters: url.filters.filter((f) => !viewer || (f !== "security" && f !== "stuck")), areas: url.area ? [url.area] : [], limit,
    ...(url.q && !url.meaning ? { q: url.q } : {}),
  }), [url.show, url.sort, url.filters.join(","), url.area, url.q, url.meaning, limit, viewer]); // eslint-disable-line react-hooks/exhaustive-deps
  const semantic = url.meaning && url.q.trim() ? url.q.trim() : null;
  const { data, error } = useQuery(`maintain-items:${JSON.stringify(query)}:${semantic ?? ""}`, async (a) => {
    if (!semantic) return a.maintain.items(query);
    const hits = await a.semanticSearch(semantic);
    if (!hits.length) return { rows: [], counts: { needs: 0, started: 0, automatic: 0, rest: 0, backlog: 0, done: 0 } };
    return a.maintain.items({ ...query, refs: hits.map(refOf) });
  });
  const { data: areaList } = useQuery(`areas:${project ?? ""}`, (a) => a.areas.get(project!), { enabled: !!project });
  const areas = project && areaList?.repo === project ? areaList.areas.map((a) => a.name) : [];

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
  const toggleFilter = (f: MaintainItemsFilter) => {
    const next = url.filters.includes(f) ? url.filters.filter((x) => x !== f) : [...url.filters, f];
    url.set("filter", next.join(",") || null);
  };
  const narrowed = url.filters.length > 0 || !!url.area || !!url.q || url.show !== "open";
  const clear = () => {
    setTyped("");
    url.setAll({ filter: null, area: null, q: null, show: null });
  };

  const groups: MaintainItemGroup[] = url.show === "closed" ? ["done"] : url.show === "backlog" ? ["backlog"] : ["needs", "started", "automatic", "rest"];
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[768px] flex-col gap-3 px-4 pb-10 pt-5 md:px-6">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-xl font-semibold">{t("Items")}</h1>
          {writes && (
            <Button icon={TerminalIcon} aria-expanded={cmdOpen} onClick={() => setCmdOpen(!cmdOpen)} className="max-md:h-11">
              {picked.size ? t("Command ({n} selected)", { n: picked.size }) : t("Command")}
            </Button>
          )}
        </div>
        {writes && cmdOpen && <CommandBox text={cmd} setText={setCmd} onDone={done} />}
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <SearchField value={typed} onChange={setTyped} onSubmit={(v) => url.set("q", v.trim() || null)} label={t("Search items")} placeholder={t("Search issues and pull requests")} />
          <Segmented
            label={t("Search by")}
            value={url.meaning ? "meaning" : "words"}
            onChange={(v) => url.set("by", v === "meaning" ? "meaning" : null)}
            options={[{ value: "words", label: t("Words") }, { value: "meaning", label: t("Meaning") }]}
            className="shrink-0 flex-nowrap"
          />
        </div>
        <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap">
          <Select value={url.show} onChange={(e) => url.set("show", e.target.value === "open" ? null : e.target.value)} aria-label={t("Show")} className="w-full max-md:h-11 md:w-auto">
            <option value="open">{t("Open")}</option>
            <option value="backlog">{t("Backlog")}</option>
            <option value="closed">{t("Closed and merged")}</option>
          </Select>
          <Select value={url.sort} onChange={(e) => url.set("sort", e.target.value === "priority" ? null : e.target.value)} aria-label={t("Sort")} className="w-full max-md:h-11 md:w-auto">
            <option value="priority">{t("Priority")}</option>
            <option value="updated">{t("Recently updated")}</option>
          </Select>
          {areas.length > 0 && (
            <Select value={url.area} onChange={(e) => url.set("area", e.target.value || null)} aria-label={t("Area")} className="w-full max-md:h-11 md:w-auto">
              <option value="">{t("All areas")}</option>
              {areas.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
              <option value="none">{t("No area")}</option>
            </Select>
          )}
        </div>
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0" role="group" aria-label={t("Filters")}>
          {FILTERS.filter((f) => !viewer || (f !== "security" && f !== "stuck")).map((f) => (
            <Chip key={f} active={url.filters.includes(f)} aria-pressed={url.filters.includes(f)} className="shrink-0 max-md:h-11" onClick={() => toggleFilter(f)}>
              {filterLabel(f)}
            </Chip>
          ))}
        </div>

        {!data ? (
          <Pending error={error} />
        ) : data.rows.length === 0 ? (
          <div className="flex flex-col items-start gap-3 rounded-lg border border-line px-4 py-6">
            <p className="text-md">{narrowed ? t("No items match.") : t("No open items.")}</p>
            {narrowed && <Button onClick={clear}>{t("Clear filters and search")}</Button>}
          </div>
        ) : (
          groups.map((g) => (
            <Group
              key={g}
              group={g}
              rows={data.rows.filter((r) => r.group === g)}
              total={data.counts[g]}
              viewer={viewer}
              picking={writes && cmdOpen}
              picked={picked}
              onPick={pick}
              onMore={() => setLimit(limit + PAGE)}
            />
          ))
        )}
      </div>
    </div>
  );
}
