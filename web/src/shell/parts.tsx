// Pieces of the app's frame: a route's view, the user menu, the shortcut sheet and the header's states.
import { lazy, Suspense, useState, type ReactNode } from "react";
import { Link, matchPath, useLocation, useNavigate, useParams } from "react-router-dom";
import { Dialog, DropdownMenu } from "radix-ui";
import { SignOutIcon, MonitorIcon, MoonIcon, SunIcon, KeyboardIcon, XIcon, CheckIcon, QuestionIcon, LinkBreakIcon, LinkIcon, HeartbeatIcon, CloudIcon, CloudCheckIcon, CloudSlashIcon } from "@phosphor-icons/react";
import { t } from "../../../src/i18n/index.ts";
import { useProjectInUrl } from "../api/scope";
import { modules } from "../registry";
import { can, roleLabel } from "../registry/permissions";
import type { Permission, RouteDef } from "../registry/types";
import { useUser } from "./UserContext";
import { Workspace } from "./Workspace";
import type { ThemePref } from "./theme";
import { useActiveShortcuts } from "./keyboard";
import { Avatar } from "../ui/atoms/Avatar";
import { Kbd } from "../ui/atoms/Kbd";
import { Badge } from "../ui/atoms/Badge";
import { cn } from "../ui/cn";
import { useApi, useQuery } from "../api/client";
import { useLiveStatus, type LiveStatus } from "../api/live";
import { MAIN_CI_DOT, MAIN_CI_LABEL } from "../ui/atoms/MainCiBadge";
import type { MainCiState } from "../api/types";
import { zoneName } from "../lib/format";
import { UnlinkDiscordDialog } from "./UnlinkDiscord";
import { LinkDiscordDialog } from "./LinkDiscord";

// Mockup builds only; a normal build drops this branch and the fixture data with it.
const MockRoleMenu = import.meta.env.VITE_MOCK === "1" ? lazy(() => import("../api/mock/MockRoleMenu")) : null;

export function RouteView({ route }: { route: RouteDef }) {
  const params = useParams();
  const user = useUser();
  if (route.permission && !can(user, route.permission)) return <div className="p-8 text-ink/60">You can't open this page.</div>;
  const view = <Workspace view={route.view} props={{ params, user }} />;
  return route.scoped ? <ProjectList>{view}</ProjectList> : view;
}

function ProjectList({ children }: { children: ReactNode }) {
  useProjectInUrl();
  return children;
}

const THEMES: { v: ThemePref; icon: typeof SunIcon; label: string }[] = [
  { v: "dark", icon: MoonIcon, label: "Dark" },
  { v: "light", icon: SunIcon, label: "Light" },
  { v: "system", icon: MonitorIcon, label: "System" },
];

const menuCls = "z-50 min-w-[220px] rounded-md border border-line-strong bg-raised p-1 shadow-[0_12px_32px_rgba(0,0,0,0.28)] animate-rise";
const itemCls = "flex h-8 cursor-default items-center gap-2.5 rounded px-2 text-sm outline-none data-[highlighted]:bg-ink/[0.07]";
const labelCls = "px-2 pb-1 pt-2 text-2xs font-medium text-ink/45";

export function UserMenu({ theme, setTheme, onHelp }: { theme: ThemePref; setTheme: (t: ThemePref) => void; onHelp?: () => void }) {
  const user = useUser();
  const api = useApi();
  const navigate = useNavigate();
  const discord = useQuery("discord-account", (a) => a.discord.account());
  const [unlinking, setUnlinking] = useState(false);
  const [linking, setLinking] = useState(false);
  return (
    <>
    <LinkDiscordDialog open={linking} linked={!!discord.data?.linked} onClose={() => setLinking(false)} />
    <UnlinkDiscordDialog open={unlinking} onClose={() => setUnlinking(false)} onDone={() => discord.refetch()} />
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="flex size-9 items-center justify-center rounded-full hover:bg-ink/[0.06]" aria-label={`Signed in as ${user.login}`}>
        <Avatar login={user.login} size={24} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className={cn(menuCls, "w-[248px]")}>
          <div className="flex items-center gap-2.5 px-2 pb-2 pt-1.5">
            <Avatar login={user.login} size={32} />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{user.login}</div>
              <div className="flex items-center gap-1.5 text-xs text-ink/55">
                <Badge tone={user.role === "operator" ? "accent" : "neutral"}>{roleLabel(user)}</Badge>
                <span>write on {user.writeRepos.length} repos</span>
              </div>
              <div className="text-xs text-ink/55">Times in {zoneName()}</div>
            </div>
          </div>
          <DropdownMenu.Separator className="-mx-1 my-1 h-px bg-line" />
          <DropdownMenu.Label className={labelCls}>Theme</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={theme} onValueChange={(v) => setTheme(v as ThemePref)}>
            {THEMES.map((th) => (
              <DropdownMenu.RadioItem key={th.v} value={th.v} className={itemCls}>
                <th.icon className="text-ink/55" />
                <span className="flex-1">{th.label}</span>
                <DropdownMenu.ItemIndicator>
                  <CheckIcon className="text-accent-ink" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          {MockRoleMenu && (
            <Suspense fallback={null}>
              <MockRoleMenu itemCls={itemCls} labelCls={labelCls} />
            </Suspense>
          )}
          <DropdownMenu.Separator className="-mx-1 my-1 h-px bg-line" />
          <DropdownMenu.Item onSelect={() => navigate("/help")} className={itemCls}>
            <QuestionIcon className="text-ink/55" /> {t("Help")}
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => onHelp?.()} className={itemCls}>
            <KeyboardIcon className="text-ink/55" /> <span className="flex-1">Keyboard shortcuts</span> <Kbd keys="?" />
          </DropdownMenu.Item>
          {discord.data?.configured && (
            <DropdownMenu.Item onSelect={() => setLinking(true)} className={itemCls}>
              <LinkIcon className="text-ink/55" /> Link Discord
            </DropdownMenu.Item>
          )}
          {discord.data?.linked && (
            <DropdownMenu.Item onSelect={() => setUnlinking(true)} className={itemCls}>
              <LinkBreakIcon className="text-ink/55" /> Unlink Discord
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item onSelect={() => void api.signOut()} className={itemCls}>
            <SignOutIcon className="text-ink/55" /> Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    </>
  );
}

export function ShortcutSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const local = useActiveShortcuts();
  const global = modules.flatMap((m) => m.commands ?? []);
  const all = [
    { id: "search", keys: "/", label: "Search", group: "Anywhere" },
    { id: "help", keys: "?", label: "Keyboard shortcuts", group: "Anywhere" },
    { id: "rail", keys: "[", label: "Toggle sidebar", group: "Anywhere" },
    ...global,
    ...local,
  ];
  const groups = [...new Set(all.map((c) => c.group))];
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 animate-fadeIn" />
        <Dialog.Content className="fixed left-1/2 top-[12vh] z-50 w-[560px] max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-lg border border-line-strong bg-raised shadow-[0_24px_64px_rgba(0,0,0,0.35)] animate-rise" aria-describedby={undefined}>
          <div className="flex h-11 items-center justify-between border-b border-line px-4">
            <Dialog.Title className="text-sm font-semibold">Keyboard shortcuts</Dialog.Title>
            <Dialog.Close className="flex size-7 items-center justify-center text-ink/50 hover:text-ink" aria-label="Close">
              <XIcon />
            </Dialog.Close>
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-4 p-4">
            {groups.map((g) => (
              <div key={g}>
                <div className="mb-1 text-xs font-semibold text-ink/55">{g}</div>
                {all
                  .filter((c) => c.group === g)
                  .map((c) => (
                    <div key={c.id} className="flex h-7 items-center justify-between gap-3 text-sm">
                      <span className="text-ink/80">{c.label}</span>
                      <Kbd keys={c.keys} />
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A page this reader's role doesn't open says so; anything else is unknown. */
export function NoRoute({ hidden }: { hidden: { path: string; permission: Permission }[] }) {
  const { pathname } = useLocation();
  const found = hidden.find((h) => matchPath({ path: `/${h.path}`, end: false }, pathname));
  const text = !found ? "Nothing here." : found.permission === "staff" ? "Operators and maintainers only." : "Operators only.";
  return <div className="p-8 text-ink/60">{text}</div>;
}

const LIVE: Record<LiveStatus, [label: string, icon: typeof CloudIcon, color: string]> = {
  open: ["Live", CloudCheckIcon, "text-ok"],
  connecting: ["Reconnecting", CloudIcon, "text-warn"],
  down: ["Offline", CloudSlashIcon, "text-bad"],
};

/** The state of the server's event stream, as an icon and a tooltip. */
export function LiveDot() {
  const [label, Icon, color] = LIVE[useLiveStatus()];
  return <Icon role="img" aria-label={label} className={cn("mx-1 shrink-0 text-[17px]", color)}><title>{label}</title></Icon>;
}

const CI_ORDER: MainCiState[] = ["green", "red", "running", "optional"];

/** Main CI of every repo at a glance: one dot and count per state, linking to the Main CI page. */
export function MainCiDots() {
  const { data } = useQuery("progress", (api) => api.progress());
  const summary = data?.mainCi;
  if (!summary) return null;
  const shown = CI_ORDER.filter((s) => s === "green" || summary[s] > 0);
  return (
    <Link to="/main-ci" className="flex shrink-0 items-center gap-1.5 px-1 text-xs text-ink/60 hover:text-ink" aria-label="Main CI" title="Main CI">
      <HeartbeatIcon className="text-sm" />
      {shown.map((s) => (
        <span key={s} className="flex items-center gap-0.5" title={`${MAIN_CI_LABEL[s]}: ${summary[s]}`}>
          <span className={cn("size-1.5 rounded-full", MAIN_CI_DOT[s])} />
          <span className="num font-medium text-ink">{summary[s]}</span>
        </span>
      ))}
    </Link>
  );
}
