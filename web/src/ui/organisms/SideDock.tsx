import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { SidebarSimpleIcon, XIcon } from "@phosphor-icons/react";
import { Tabs } from "../molecules/Tabs";
import { cn } from "../cn";
import { layoutStorage, usePref } from "../../shell/layoutStorage";
import { useIsPhone } from "../../shell/useMedia";
import { t } from "../../../../src/i18n/index.ts";

export interface DockView<V extends string = string> {
  value: V;
  label: string;
  content: ReactNode;
  /** Percent of the width the panel takes the first time this view opens; the viewer's own width is kept after that. */
  defaultSize: number;
  count?: number;
}

/** The selected view and whether the panel is open, remembered per viewer. */
export function useDockState<V extends string>(login: string, id: string, views: Pick<DockView<V>, "value">[]) {
  const [saved, setView] = usePref<V>(login, `dock:${id}:view`, views[0]!.value);
  const [open, setOpen] = usePref<boolean>(login, `dock:${id}:open`, true);
  const view = views.some((v) => v.value === saved) ? saved : views[0]!.value;
  return { view, setView, open, setOpen };
}

interface DockProps<V extends string> {
  /** Names the dock in storage and in element ids. */
  id: string;
  login: string;
  /** The page header: full width above the main column and the panel. */
  header?: ReactNode;
  main: ReactNode;
  /** Phone tab for the main column. */
  mainLabel: string;
  views: DockView<V>[];
  view: V;
  onView: (v: V) => void;
  /** Wide: the panel shows. Phones: a view's tab is selected instead of the main column. */
  open: boolean;
  onOpen: (open: boolean) => void;
}

const MAIN_MIN = 40;

/**
 * A main column with a resizable side panel that switches between views. The panel's width is remembered per viewer and
 * per view. On phones there is no panel: tabs under the header switch the page between the main column and each view.
 */
export function SideDock<V extends string>(p: DockProps<V>) {
  const phone = useIsPhone();
  return (
    <div className="flex h-full min-h-0 flex-col">
      {p.header}
      {phone ? <PhoneTabs {...p} /> : <WideDock {...p} />}
    </div>
  );
}

/** Phones: Chat · GitHub · Events as tabs. The main column stays mounted while another tab shows, so a draft in it survives. */
function PhoneTabs<V extends string>({ id, main, mainLabel, views, view, onView, open, onOpen }: DockProps<V>) {
  const showMain = !open;
  const options = [{ value: "main" as const, label: mainLabel }, ...views.map((v) => ({ value: v.value as V | "main", label: v.label, count: v.count }))];
  const value = showMain ? "main" : view;
  const current = views.find((v) => v.value === view);
  return (
    <>
      <Tabs
        idBase={`${id}-phone`}
        label={t("Page sections")}
        value={value}
        options={options}
        onChange={(v) => {
          if (v === "main") onOpen(false);
          else {
            onView(v);
            onOpen(true);
          }
        }}
        className="shrink-0 bg-panel px-2 [&>button]:flex-1 [&>button]:justify-center"
      />
      <div
        role="tabpanel"
        id={`${id}-phone-panel-main`}
        aria-labelledby={`${id}-phone-tab-main`}
        hidden={!showMain}
        className="min-h-0 flex-1 overflow-hidden"
      >
        {main}
      </div>
      {!showMain && current && (
        <div
          role="tabpanel"
          id={`${id}-phone-panel-${current.value}`}
          aria-labelledby={`${id}-phone-tab-${current.value}`}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {current.content}
        </div>
      )}
    </>
  );
}

function WideDock<V extends string>({ id, login, main, views, view, onView, open, onOpen }: DockProps<V>) {
  const storage = useMemo(() => layoutStorage(login), [login]);
  const current = views.find((v) => v.value === view) ?? views[0]!;
  const railButton = useRef<HTMLButtonElement>(null);
  const sideBox = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const sidePanel = useRef<ImperativePanelHandle>(null);
  // Each view keeps its own width. One panel group serves every view, so the tab bar keeps focus while the width swaps.
  const widthKey = (v: string) => `dock:${id}:width:${v}`;
  const widthOf = (v: DockView<V>) => {
    const n = Number(storage.getItem(widthKey(v.value)));
    return n >= 20 && n <= 100 - MAIN_MIN ? n : v.defaultSize;
  };
  const shown = useRef(current.value);
  useEffect(() => {
    shown.current = current.value;
    sidePanel.current?.resize(widthOf(current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.value]);
  // Opening or closing by the viewer moves focus to where the control went; the first render leaves focus alone.
  useEffect(() => {
    if (!moved.current) return;
    (open ? sideBox.current : railButton.current)?.focus();
  }, [open]);
  const toggle = (next: boolean) => {
    moved.current = true;
    onOpen(next);
  };

  if (!open) {
    return (
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">{main}</div>
        <button
          ref={railButton}
          onClick={() => toggle(true)}
          aria-label={t("Show side panel")}
          className="flex w-9 shrink-0 flex-col items-center gap-3 border-l border-line bg-panel pt-3 text-ink/70 hover:text-ink"
        >
          <SidebarSimpleIcon aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <PanelGroup
      direction="horizontal"
      className="min-h-0 flex-1"
    >
      <Panel id="main" order={0} defaultSize={100 - widthOf(current)} minSize={MAIN_MIN} className="min-w-0">
        {main}
      </Panel>
      <PanelResizeHandle
        aria-label={t("Resize side panel")}
        className="group relative flex w-2 shrink-0 items-stretch justify-center focus-visible:outline-none"
      >
        <span className="w-px bg-line group-hover:bg-ink/30 group-focus-visible:w-0.5 group-focus-visible:bg-accent-ink group-data-[resize-handle-active]:bg-accent-ink" />
      </PanelResizeHandle>
      <Panel ref={sidePanel} id="side" order={1} defaultSize={widthOf(current)} onResize={(size) => storage.setItem(widthKey(shown.current), String(Math.round(size * 10) / 10))} minSize={20} maxSize={100 - MAIN_MIN} className="min-w-0">
        <div ref={sideBox} tabIndex={-1} aria-label={t("Side panel")} role="region" className={cn("flex h-full min-h-0 flex-col bg-panel outline-none")}>
          <div className="flex shrink-0 items-center border-b border-line pr-1">
            <Tabs
              idBase={`${id}-side`}
              label={t("Side panel views")}
              value={current.value}
              options={views.map((v) => ({ value: v.value, label: v.label, count: v.count }))}
              onChange={onView}
              className="min-w-0 flex-1 border-b-0 px-1"
            />
            <button
              onClick={() => toggle(false)}
              aria-label={t("Close side panel")}
              title={t("Close side panel")}
              className="flex size-10 shrink-0 items-center justify-center text-ink/70 hover:bg-ink/5 hover:text-ink"
            >
              <XIcon aria-hidden />
            </button>
          </div>
          <div
            role="tabpanel"
            id={`${id}-side-panel-${current.value}`}
            aria-labelledby={`${id}-side-tab-${current.value}`}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            {current.content}
          </div>
        </div>
      </Panel>
    </PanelGroup>
  );
}
