// Workable: the one way to show a PR or an issue in a list. A table whose rows are items: the item's id and the issues it closes (both open
// GitHub), its title (opens the item page) with a line below it, then the page's own columns. Rows sit in groups with a header bar (title,
// count, hint and a control).
// The table measures its own width (so an open rail counts) and takes the roomiest layout that fits:
// - full: every column at `width`, the Closes column;
// - mid: wide columns are left out;
// - compact: no wide columns, `mdWidth` tracks, the closed issues under the id instead of a column;
// - phone: no header, a row's cells wrap under the title.
import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { ItemKind, ItemState } from "../../api/types";
import { ItemIcon, type IconKind } from "../atoms/ItemIcon";
import { Tooltip } from "../atoms/Tooltip";
import { ItemPeek } from "../molecules/ItemPeek";
import { githubItemUrl, itemPath } from "../../lib/links";
import { num } from "../../lib/format";
import { useIsPhone } from "../../shell/useMedia";
import { cn } from "../cn";

export interface WorkableColumn {
  id: string;
  label: ReactNode;
  /** A CSS grid track in px, e.g. `120px`. */
  width: string;
  /** The track in the compact layout; `width` when absent. */
  mdWidth?: string;
  /** Header tooltip. */
  hint?: string;
  align?: "start" | "center" | "end";
  /** The header label runs bottom to top, so a column of icons can be as narrow as an icon. */
  vertical?: boolean;
  /** Left out unless the table has room for every column (and on a phone, where cells wrap). */
  wide?: boolean;
  /** An empty cell stays blank instead of showing a dash (columns of icons, where a row of dashes is noise). */
  blank?: boolean;
}

export interface WorkableItem {
  repo: string;
  number: number;
  /** "finding": a security finding, which has no GitHub page; give it an `id`. */
  kind?: IconKind | null;
  state?: ItemState | null;
  draft?: boolean;
  title: string | null | undefined;
  /** Issues in the same repo this PR closes when it merges. */
  closes?: number[];
  /** Where the title links; the item page when absent (a decision row opens its decision). */
  to?: string;
  /** Stands in for the GitHub `#number` link, for rows that are not a GitHub item (a security finding). */
  id?: ReactNode;
}

export type WorkableLayout = "full" | "mid" | "compact" | "phone";

interface Shape {
  layout: WorkableLayout;
  /** The page columns drawn. */
  cells: WorkableColumn[];
  /** The closed issues in their own column, under the id, or not at all. */
  closes: "column" | "under" | null;
  template: string;
}
const Shape = createContext<Shape>({ layout: "full", cells: [], closes: null, template: "" });

/** The layout the surrounding table took, for cells that change shape with it. */
export const useWorkableLayout = () => useContext(Shape).layout;

const ID_W = 104;
const CLOSES_W = 96;
const PAD = 32;
/** The narrowest the title gets in each layout. */
const TITLE = { full: 260, mid: 220, compact: 180, phone: 0 };
const gapOf = (l: WorkableLayout) => (l === "full" ? 16 : 12);

const trackOf = (c: WorkableColumn, l: WorkableLayout) => (l === "compact" ? c.mdWidth ?? c.width : c.width);
const shown = (cols: WorkableColumn[], l: WorkableLayout) => (l === "full" || l === "phone" ? cols : cols.filter((c) => !c.wide));
const closesIn = (closes: boolean, l: WorkableLayout): Shape["closes"] => (!closes ? null : l === "full" || l === "mid" ? "column" : "under");
/** The width the cells need: the id, the Closes column, the title, every page column, the gaps between them and the row padding. */
const need = (cols: WorkableColumn[], closes: boolean, l: WorkableLayout) =>
  PAD + ID_W + gapOf(l) + (closesIn(closes, l) === "column" ? CLOSES_W + gapOf(l) : 0) + TITLE[l] + shown(cols, l).reduce((s, c) => s + (parseFloat(trackOf(c, l)) || 0) + gapOf(l), 0);

function shapeOf(cols: WorkableColumn[], closes: boolean, l: WorkableLayout): Shape {
  const cells = shown(cols, l);
  const c = closesIn(closes, l);
  return { layout: l, cells, closes: c, template: [`${ID_W}px`, ...(c === "column" ? [`${CLOSES_W}px`] : []), `minmax(${TITLE[l]}px,1fr)`, ...cells.map((x) => trackOf(x, l))].join(" ") };
}

/** The table's width, kept current. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const ALIGN = { start: "", center: "justify-center text-center", end: "justify-end text-right" };

/** Extra width a wider layout needs over its threshold before the table switches up to it: more than a classic scrollbar, so a layout
 * whose height adds or removes the page's scrollbar does not switch back and forth. */
const HYSTERESIS = 24;
const RANK: Record<Exclude<WorkableLayout, "phone">, number> = { full: 0, mid: 1, compact: 2 };

function layoutFor(width: number | null, cols: WorkableColumn[], closes: boolean, prev: WorkableLayout): WorkableLayout {
  if (width === null) return "full";
  const from = prev === "phone" ? 0 : RANK[prev];
  for (const l of ["full", "mid"] as const) if (width >= need(cols, closes, l) + (RANK[l] < from ? HYSTERESIS : 0)) return l;
  return "compact";
}

/** `closes` adds the closed issues after the id. */
export function WorkableTable({ columns, label, closes = false, titleLabel = "Title", children, className }: {
  columns: WorkableColumn[];
  label: string;
  closes?: boolean;
  titleLabel?: string;
  children: ReactNode;
  className?: string;
}) {
  const phone = useIsPhone();
  const [ref, width] = useWidth();
  const last = useRef<WorkableLayout>("full");
  const layout: WorkableLayout = phone ? "phone" : layoutFor(width, columns, closes, last.current);
  last.current = layout;
  const shape = shapeOf(columns, closes, layout);
  return (
    <Shape.Provider value={shape}>
      <div ref={ref} className={cn("overflow-x-auto rounded-md border border-line", className)}>
        <div role="table" aria-label={label} data-layout={layout} className="text-sm" style={layout === "compact" ? { minWidth: need(columns, closes, "compact") } : undefined}>
          {layout !== "phone" && (
            <div role="row" className={cn("grid items-end border-b border-line bg-ink/[0.03] px-4 py-1.5 text-xs font-medium text-ink/55", layout === "full" ? "gap-x-4" : "gap-x-3")} style={{ gridTemplateColumns: shape.template }}>
              <span role="columnheader">ID</span>
              {shape.closes === "column" && (
                <span role="columnheader">
                  <Tooltip content="Issues it closes when it merges">
                    <span className="cursor-help">Closes</span>
                  </Tooltip>
                </span>
              )}
              <span role="columnheader">{titleLabel}</span>
              {shape.cells.map((c) => (
                <span key={c.id} role="columnheader" className={cn("flex", ALIGN[c.align ?? "start"])}>
                  <Tooltip content={c.hint}>
                    <span className={cn(c.hint && "cursor-help", c.vertical && "rotate-180 whitespace-nowrap leading-none [writing-mode:vertical-rl]")}>{c.label}</span>
                  </Tooltip>
                </span>
              ))}
            </div>
          )}
          {children}
        </div>
      </div>
    </Shape.Provider>
  );
}

/** A group of rows under a header bar. */
export function WorkableGroup({ title, count, hint, dot, aside, children, id }: { title: ReactNode; count?: number; hint?: ReactNode; dot?: string; aside?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <div role="rowgroup" id={id} className="border-b border-line last:border-0">
      <div role="row" className="flex min-h-9 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-line bg-ink/[0.04] px-4 py-1.5">
        <span role="rowheader" className="inline-flex items-center gap-2 text-sm font-semibold">
          {dot && <span className={cn("size-2 rounded-full", dot)} aria-hidden />}
          {title}
        </span>
        {count !== undefined && <span className="num rounded-full bg-ink/[0.07] px-1.5 text-2xs text-ink/70">{num(count)}</span>}
        {hint && <span className="min-w-0 flex-1 basis-60 text-xs text-ink/50">{hint}</span>}
        {aside && <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">{aside}</span>}
      </div>
      {children}
    </div>
  );
}

/** `#123` that opens the item on GitHub, with the item's hover card. */
function GithubId({ repo, number, kind }: { repo: string; number: number; kind: ItemKind | null | undefined }) {
  return (
    <ItemPeek repo={repo} number={number}>
      <a href={githubItemUrl(repo, number, kind)} target="_blank" rel="noopener noreferrer" aria-label={`${repo}#${number} on GitHub`} className="code relative z-10 text-accent-ink hover:underline">
        #{number}
      </a>
    </ItemPeek>
  );
}

function Closes({ repo, closes, label }: { repo: string; closes: number[]; label?: boolean }) {
  return (
    <>
      {label && <span className="text-2xs text-ink/45">closes</span>}
      {closes.map((n) => (
        <GithubId key={n} repo={repo} number={n} kind="issue" />
      ))}
    </>
  );
}

/**
 * One item. `mark` sits before the title (a fast-track marker); `sub` is a line under the title; `cells` fill the table's columns by id.
 * Only the title opens the item; the rest of the row is not a link.
 */
export function WorkableRow({ item, mark, sub, cells, highlight, dataItem }: {
  item: WorkableItem;
  mark?: ReactNode;
  sub?: ReactNode;
  cells: Record<string, ReactNode>;
  highlight?: boolean;
  dataItem?: string;
}) {
  const shape = useContext(Shape);
  const phone = shape.layout === "phone";
  const closes = item.closes?.length ? item.closes : null;
  return (
    <div role="row" data-item={dataItem} className={cn("relative border-b border-line px-4 py-2 last:border-0 hover:bg-ink/[0.03]", highlight && "bg-accent/10")}>
      <div
        className={phone ? "flex flex-wrap items-center gap-x-2.5 gap-y-1.5" : cn("grid items-start", shape.layout === "full" ? "gap-x-4" : "gap-x-3")}
        style={phone ? undefined : { gridTemplateColumns: shape.template }}
      >
        <div role="cell" className="flex min-w-0 items-start gap-1.5">
          <ItemIcon kind={item.kind} state={item.state} draft={item.draft} />
          <span className="min-w-0">
            {item.id ?? <GithubId repo={item.repo} number={item.number} kind={item.kind === "finding" ? null : item.kind} />}
            {!phone && (
              <span className="block truncate text-2xs text-ink/45" title={item.repo}>
                {item.repo}
              </span>
            )}
            {shape.closes === "under" && closes && (
              <span className={cn("flex-wrap items-baseline gap-x-1.5", phone ? "ml-1.5 inline-flex" : "flex")}>
                <Closes repo={item.repo} closes={closes} label />
              </span>
            )}
          </span>
        </div>
        {shape.closes === "column" && <div role="cell" className="flex min-w-0 flex-wrap items-start gap-x-1.5">{closes ? <Closes repo={item.repo} closes={closes} /> : <span className="text-ink/30">–</span>}</div>}
        <div role="cell" className={cn("min-w-0", phone && "order-first basis-full")}>
          <div className="flex items-start gap-1.5">
            {mark}
            <Link to={item.to ?? itemPath(item.repo, item.number)} className="min-w-0 break-words hover:underline [overflow-wrap:anywhere]">
              {item.title || `${item.repo}#${item.number}`}
            </Link>
          </div>
          {sub && <div className="mt-0.5 text-2xs text-ink/55">{sub}</div>}
        </div>
        {shape.cells.map((c) => {
          const v = cells[c.id];
          if (phone && v == null) return null;
          return (
            <div key={c.id} role="cell" className={cn("min-w-0 pt-0.5", !phone && c.align && c.align !== "start" && cn("flex", ALIGN[c.align]), phone && c.align === "end" && "ml-auto")}>
              {v ?? (c.blank ? null : <span className="text-ink/30">–</span>)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
