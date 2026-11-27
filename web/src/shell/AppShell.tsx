// The app's frame: a left rail per role on desktop (collapsible), a header with search, Main CI, the live state, health warnings
// and the user menu, and on phones a header, a drawer and bottom tabs.
import { useEffect, useMemo, useState } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Dialog } from "radix-ui";
import { BookOpenIcon, CaretRightIcon, ChartLineUpIcon, CpuIcon, GearSixIcon, HouseIcon, ListBulletsIcon, ListIcon, MagnifyingGlassIcon, QuestionIcon, QueueIcon, SidebarSimpleIcon, XIcon, type Icon } from "@phosphor-icons/react";
import { t, tk } from "../../../src/i18n/index.ts";
import { modules } from "../registry";
import { can } from "../registry/permissions";
import type { Permission, RouteDef } from "../registry/types";
import { useQuery } from "../api/client";
import type { User } from "../api/types";
import { LiveDot, MainCiDots, NoRoute, RouteView, ShortcutSheet, UserMenu } from "./parts";
import { redirectRoutes } from "./redirects";
import { ScopePicker, useStalePickCleared } from "./ScopePicker";
import { SearchBox } from "./SearchBox";
import { useUser } from "./UserContext";
import { useIsPhone } from "./useMedia";
import { useTheme } from "./theme";
import { usePref } from "./layoutStorage";
import { useHotkeys } from "./keyboard";
import { HealthMenu } from "../ui/organisms/HealthMenu";
import { Kbd } from "../ui/atoms/Kbd";
import { Logo } from "../ui/atoms/Logo";
import { cn } from "../ui/cn";

/** A rail page; `also` are the other paths it stays lit on. A page whose view the user cannot open is left out. */
interface Page {
  to: string;
  label: string;
  icon?: Icon;
  also?: string[];
}

const MAIN: Page[] = [
  { to: "/", label: tk("Home"), icon: HouseIcon },
  { to: "/items", label: tk("Items"), icon: ListBulletsIcon },
  { to: "/queue", label: tk("Work queue"), icon: QueueIcon, also: ["/next", "/batches", "/model-queue"] },
  { to: "/stats", label: tk("Stats"), icon: ChartLineUpIcon, also: ["/progress", "/activity", "/cost", "/downloads", "/rates", "/agents", "/classifiers", "/main-ci", "/nightly", "/stuck"] },
];
const RUNNER: Page = { to: "/runner", label: tk("Runner"), icon: CpuIcon, also: ["/connect"] };
const REFERENCE: Page[] = [
  { to: "/prompts", label: tk("Prompts") },
  { to: "/envs", label: tk("Environments"), also: ["/workspaces"] },
  { to: "/repos", label: tk("Repos") },
  { to: "/scans", label: tk("Scans"), also: ["/security"] },
];
const ADMIN: Page[] = [
  { to: "/admin/users", label: tk("Users and access"), also: ["/access", "/contributors"] },
  { to: "/admin/health", label: tk("Health") },
  { to: "/admin/sweeps", label: tk("Sweeps"), also: ["/nightly"] },
  { to: "/admin/settings", label: tk("Instance settings"), also: ["/pipeline"] },
  { to: "/admin/inference", label: tk("Inference"), also: ["/inference"] },
  { to: "/admin/github-app", label: tk("GitHub App") },
  { to: "/admin/discord", label: tk("Discord") },
  { to: "/admin/limits", label: tk("Limits") },
  { to: "/admin/audit", label: tk("Audit log"), also: ["/audit"] },
];
const HELP: Page = { to: "/help", label: tk("Help"), icon: QuestionIcon };

const under = (pathname: string, path: string) => (path === "/" ? pathname === "/" : pathname === path || pathname.startsWith(`${path}/`));
const lit = (p: Page, pathname: string) => under(pathname, p.to) || !!p.also?.some((a) => under(pathname, a));

/** The registered route a page shows. */
function routeOf(p: Page, routes: RouteDef[]): RouteDef | undefined {
  const path = p.to === "/" ? "/" : p.to.slice(1);
  return routes.find((r) => r.path === path || r.path.startsWith(`${path}/:`));
}

function useRail(user: User, routes: RouteDef[]) {
  const opens = (p: Page) => {
    const r = routeOf(p, routes);
    return !!r && (!r.permission || can(user, r.permission));
  };
  const staff = user.role !== "viewer";
  return {
    main: [...MAIN, ...(staff ? [RUNNER] : [])].filter(opens),
    groups: [
      { id: "reference", label: tk("Reference"), icon: BookOpenIcon, pages: REFERENCE.filter(opens) },
      { id: "admin", label: tk("Admin"), icon: GearSixIcon, pages: user.role === "operator" ? ADMIN.filter(opens) : [] },
    ].filter((g) => g.pages.length),
    help: opens(HELP) ? HELP : null,
  };
}
type Rail = ReturnType<typeof useRail>;

/** Open questions addressed to the reader, for the Home entry. */
function useNeedsCount(): number | undefined {
  const { data } = useQuery("maintain-asked", (a) => a.maintain.asked(), { project: null });
  return data?.count || undefined;
}

function RailLink({ p, open, tall, count }: { p: Page; open: boolean; tall?: boolean; count?: number }) {
  const { pathname } = useLocation();
  const on = lit(p, pathname);
  const label = t(p.label);
  const Ico = p.icon!;
  return (
    <NavLink
      to={p.to}
      end={p.to === "/"}
      aria-current={on ? "page" : undefined}
      title={open ? undefined : label}
      aria-label={open ? undefined : count ? `${label}, ${count}` : label}
      className={cn("relative flex items-center gap-2 rounded px-2 text-sm text-ink/70 transition-colors duration-fast hover:bg-ink/[0.06] hover:text-ink", tall ? "h-11" : "h-8", on && "bg-ink/[0.08] font-medium text-ink", !open && "justify-center px-0")}
    >
      <Ico aria-hidden className="text-[15px] opacity-80" />
      {open && <span className="flex-1 truncate">{label}</span>}
      {open && !!count && <span className="num text-xs text-ink/60">{count}</span>}
      {!open && !!count && <span aria-hidden className="absolute right-1 top-1 size-1.5 rounded-full bg-accent" />}
    </NavLink>
  );
}

/** A collapsible group of pages; the choice is remembered. The collapsed rail shows it as one icon, linking to its first page. */
function RailGroup({ g, open, tall }: { g: Rail["groups"][number]; open: boolean; tall?: boolean }) {
  const user = useUser();
  const { pathname } = useLocation();
  const here = g.pages.some((p) => lit(p, pathname));
  const [expanded, setExpanded] = usePref(user.login, `rail2-group-${g.id}`, true);
  const label = t(g.label);
  const row = cn("flex items-center gap-2 rounded px-2 text-sm text-ink/70 hover:bg-ink/[0.06] hover:text-ink", tall ? "h-11" : "h-8");
  if (!open)
    return (
      <NavLink to={g.pages[0]!.to} title={label} aria-label={label} className={cn(row, "justify-center px-0", here && "bg-ink/[0.08] text-ink")}>
        <g.icon aria-hidden className="text-[15px] opacity-80" />
      </NavLink>
    );
  const show = expanded || here;
  return (
    <div className="mt-1">
      <button type="button" onClick={() => setExpanded(!show)} aria-expanded={show} className={cn(row, "w-full text-left")}>
        <g.icon aria-hidden className="text-[15px] opacity-80" />
        <span className="flex-1">{label}</span>
        <CaretRightIcon aria-hidden className={cn("text-[11px] text-ink/50 transition-transform duration-fast", show && "rotate-90")} />
      </button>
      {show && (
        <div className="ml-[15px] border-l border-line pl-1.5">
          {g.pages.map((p) => {
            const on = lit(p, pathname);
            return (
              <NavLink key={p.to} to={p.to} aria-current={on ? "page" : undefined} className={cn("flex items-center rounded px-2 text-sm text-ink/70 hover:bg-ink/[0.06] hover:text-ink", tall ? "h-10" : "h-7", on && "bg-ink/[0.08] font-medium text-ink")}>
                {t(p.label)}
              </NavLink>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RailNav({ rail, open, tall, className }: { rail: Rail; open: boolean; tall?: boolean; className?: string }) {
  const needs = useNeedsCount();
  return (
    <nav aria-label={t("Main")} className={cn("overflow-y-auto px-2 pb-3 pt-1", className)}>
      {rail.main.map((p) => (
        <RailLink key={p.to} p={p} open={open} tall={tall} count={p.to === "/" ? needs : undefined} />
      ))}
      {rail.groups.map((g) => (
        <RailGroup key={g.id} g={g} open={open} tall={tall} />
      ))}
    </nav>
  );
}

function Wordmark() {
  return (
    <NavLink to="/" aria-label={t("AutoCraft home")} className="flex items-center gap-2 rounded">
      <Logo size={20} />
      <span className="text-sm font-semibold">AutoCraft</span>
    </NavLink>
  );
}

/** Phone: the first four main pages as tabs (Help joins when there are fewer); the drawer has the rest. */
function PhoneTabs({ rail }: { rail: Rail }) {
  const { pathname } = useLocation();
  const needs = useNeedsCount();
  const tabs = [...rail.main.slice(0, 4), ...(rail.main.length < 4 && rail.help ? [rail.help] : [])];
  return (
    <nav aria-label={t("Primary")} style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }} className="grid shrink-0 border-t border-line bg-bg pb-[env(safe-area-inset-bottom)]">
      {tabs.map((p) => {
        const on = lit(p, pathname);
        const count = p.to === "/" ? needs : undefined;
        const Ico = p.icon!;
        return (
          <NavLink key={p.to} to={p.to} end={p.to === "/"} aria-current={on ? "page" : undefined} className={cn("relative flex h-14 flex-col items-center justify-center gap-0.5 rounded text-2xs font-medium text-ink/60", on && "text-accent-ink")}>
            <span className="relative">
              <Ico aria-hidden className="text-[20px]" />
              {!!count && <span className="num absolute -right-3.5 -top-1 rounded-full bg-accent px-1 text-[10px] font-semibold leading-[14px] text-white">{count}</span>}
            </span>
            {p.to === "/queue" ? t("Queue") : t(p.label)}
          </NavLink>
        );
      })}
    </nav>
  );
}

/** Phone: the rail in a left drawer. Radix Dialog supplies the focus trap, Escape, scroll lock and focus return. */
function NavDrawer({ open, onOpenChange, rail }: { open: boolean; onOpenChange: (o: boolean) => void; rail: Rail }) {
  const { pathname } = useLocation();
  useEffect(() => onOpenChange(false), [pathname, onOpenChange]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 animate-fadeIn" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            document.getElementById("nav-toggle")?.focus();
          }}
          className="fixed inset-y-0 left-0 z-50 flex w-[280px] max-w-[85vw] flex-col border-r border-line bg-bg pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pt-[env(safe-area-inset-top)] animate-fadeIn"
        >
          <Dialog.Title className="sr-only">{t("Navigation")}</Dialog.Title>
          <div className="flex h-12 shrink-0 items-center justify-between pl-4 pr-1.5">
            <Wordmark />
            <Dialog.Close className="flex size-11 items-center justify-center rounded text-ink/70" aria-label={t("Close navigation")}>
              <XIcon aria-hidden />
            </Dialog.Close>
          </div>
          <div className="px-2 pb-2">
            <ScopePicker modal onPicked={() => onOpenChange(false)} />
          </div>
          <RailNav rail={rail} open tall className="min-h-0 flex-1 overscroll-contain" />
          {rail.help && (
            <div className="border-t border-line px-2 py-1">
              <RailLink p={rail.help} open tall />
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function AppShell() {
  const user = useUser();
  const phone = useIsPhone();
  const navigate = useNavigate();
  const [theme, setTheme] = useTheme();
  const [railOpen, setRailOpen] = usePref(user.login, "rail-open", true);
  const [help, setHelp] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  useStalePickCleared();

  const visible = useMemo(() => modules.filter((m) => can(user, m.permission)), [user]);
  const routes = visible.flatMap((m) => m.routes);
  const rail = useRail(user, routes);
  const hiddenPaths = useMemo(() => modules.filter((m) => !can(user, m.permission)).flatMap((m) => m.routes.map((r) => ({ path: r.path, permission: m.permission as Permission }))), [user]);

  const search = () => (phone ? setSearchOpen(true) : document.getElementById("global-search")?.focus());
  useHotkeys({
    "/": search,
    "mod+k": search,
    "?": () => setHelp(true),
    "[": () => setRailOpen(!railOpen),
    "g h": () => navigate("/"),
    "g i": () => navigate("/items"),
    "g q": () => navigate("/queue"),
    "g s": () => navigate("/stats"),
    "g p": () => navigate("/progress"),
  });

  const content = (
    <Routes>
      {routes.map((r) => (
        <Route key={r.path} path={r.path} element={<RouteView route={r} />} />
      ))}
      {redirectRoutes}
      <Route path="*" element={<NoRoute hidden={hiddenPaths} />} />
    </Routes>
  );

  if (phone) {
    return (
      <div className="flex h-full flex-col bg-panel">
        <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line bg-bg pl-1 pr-1.5">
          <button id="nav-toggle" type="button" aria-label={t("Open navigation")} onClick={() => setNavOpen(true)} className="flex size-11 shrink-0 items-center justify-center rounded text-ink/70">
            <ListIcon aria-hidden className="text-[20px]" />
          </button>
          <NavLink to="/" aria-label={t("AutoCraft home")} className="flex size-11 shrink-0 items-center justify-center rounded">
            <Logo size={20} />
          </NavLink>
          <div className="flex-1" />
          <MainCiDots />
          <LiveDot />
          <HealthMenu />
          <button type="button" aria-label={t("Search")} onClick={() => setSearchOpen(true)} className="flex size-11 items-center justify-center rounded text-ink/70">
            <MagnifyingGlassIcon aria-hidden className="text-[18px]" />
          </button>
          <UserMenu theme={theme} setTheme={setTheme} onHelp={() => setHelp(true)} />
        </header>
        <main className="min-h-0 flex-1">{content}</main>
        <PhoneTabs rail={rail} />
        <NavDrawer open={navOpen} onOpenChange={setNavOpen} rail={rail} />
        <Dialog.Root open={searchOpen} onOpenChange={setSearchOpen}>
          <Dialog.Portal>
            <Dialog.Content className="fixed inset-0 z-50 flex flex-col bg-panel animate-fadeIn" aria-describedby={undefined}>
              <Dialog.Title className="sr-only">{t("Search")}</Dialog.Title>
              <div className="flex items-start gap-1 border-b border-line p-2">
                <SearchBox autoFocus onPick={() => setSearchOpen(false)} fullscreen />
                <Dialog.Close className="flex size-11 shrink-0 items-center justify-center text-ink/70" aria-label={t("Close search")}>
                  <XIcon aria-hidden />
                </Dialog.Close>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        <ShortcutSheet open={help} onOpenChange={setHelp} />
      </div>
    );
  }

  return (
    <div className="flex h-full bg-bg">
      <aside className={cn("flex shrink-0 flex-col border-r border-line bg-bg transition-[width] duration-base ease-out", railOpen ? "w-[220px]" : "w-[52px]")}>
        <div className={cn("flex h-11 shrink-0 items-center px-4", !railOpen && "justify-center px-0")}>
          {railOpen ? (
            <Wordmark />
          ) : (
            <NavLink to="/" aria-label={t("AutoCraft home")} className="rounded">
              <Logo size={20} />
            </NavLink>
          )}
        </div>
        {railOpen && (
          <div className="px-2 pb-2">
            <ScopePicker />
          </div>
        )}
        <RailNav rail={rail} open={railOpen} className="flex-1" />
        {rail.help && (
          <div className="px-2 pb-1">
            <RailLink p={rail.help} open={railOpen} />
          </div>
        )}
        <div className={cn("flex items-center border-t border-line p-2", !railOpen && "justify-center")}>
          <button type="button" onClick={() => setRailOpen(!railOpen)} className="flex size-8 items-center justify-center rounded text-ink/60 hover:bg-ink/[0.06] hover:text-ink" aria-label={railOpen ? t("Collapse sidebar") : t("Expand sidebar")} aria-expanded={railOpen}>
            <SidebarSimpleIcon aria-hidden className="text-[15px]" />
          </button>
          {railOpen && (
            <button type="button" onClick={() => setHelp(true)} className="ml-auto flex h-8 items-center gap-2 rounded px-2 text-xs text-ink/60 hover:bg-ink/[0.06] hover:text-ink">
              {t("Shortcuts")} <Kbd keys="?" />
            </button>
          )}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-bg pl-4 pr-2">
          <div className="mx-auto w-full max-w-[440px]">
            <SearchBox />
          </div>
          <MainCiDots />
          <LiveDot />
          <HealthMenu />
          <UserMenu theme={theme} setTheme={setTheme} onHelp={() => setHelp(true)} />
        </header>
        <main className="min-h-0 flex-1 bg-panel">{content}</main>
      </div>
      <ShortcutSheet open={help} onOpenChange={setHelp} />
    </div>
  );
}
