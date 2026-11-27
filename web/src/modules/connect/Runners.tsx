import { CaretDownIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useApi, useQuery } from "../../api/client";
import type { HelperReadiness, LoginScopes, RunnerInfo, UsageWindow } from "../../api/types";
import { Badge, type Tone } from "../../ui/atoms/Badge";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Input } from "../../ui/atoms/Input";
import { Switch } from "../../ui/atoms/Switch";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { Block } from "../../ui/molecules/Block";
import { CheckRow } from "../../ui/molecules/CheckRow";
import { ConfirmButton } from "../../ui/molecules/ConfirmButton";
import { clock, day, nowMs } from "../../lib/format";
import { useWrite } from "../../lib/hooks";
import { cn } from "../../ui/cn";
import { SectionTitle } from "./SectionTitle";

/** A runner made this recently carries a "new" badge, so one the user did not add stands out. */
const NEW_MS = 24 * 3600_000;

const PLATFORMS: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };
const platform = (p: string) => PLATFORMS[p] ?? p;

const readinessBadge = (h: RunnerInfo): { text: string; tone: Tone } => {
  if (!h.readiness) return { text: "No status yet", tone: "neutral" };
  if (!h.fresh) return { text: "Not running", tone: "neutral" };
  const until = (word: string) => `${word}${h.until ? ` until ${clock(h.until)}` : ""}`;
  const map: Record<HelperReadiness, { text: string; tone: Tone }> = {
    ready: { text: "Ready", tone: "ok" },
    "quota-held": { text: until("Holding"), tone: "warn" },
    paused: { text: until("Paused"), tone: "warn" },
    "cooled-off": { text: until("Cooling off"), tone: "warn" },
    "sandbox-failed": { text: "Sandbox check failed", tone: "bad" },
    "version-refused": { text: "Runner too old", tone: "bad" },
    "harness-missing": { text: "Harness missing", tone: "bad" },
    failing: { text: until("Calls failing"), tone: "bad" },
    "login-refresh": { text: until("Waiting for login refresh"), tone: "warn" },
  };
  return map[h.readiness];
};

const used = (w: UsageWindow | null | undefined) => (w ? `${Math.round(w.usedPercent)}%` : "–");

const AGENT = "Agent access";
const ANSWER = "Can send commands and approve merges";
/** Answering works only through agent access: ticking it ticks agent access, and unticking agent access unticks it. */
const withAgent = (s: LoginScopes, agent: boolean): LoginScopes => ({ agent, answer: agent && s.answer });
const withAnswer = (s: LoginScopes, answer: boolean): LoginScopes => ({ agent: s.agent || answer, answer });

/** The user's Task Runners, the setup steps, and the approval of a device login (`?runner=CODE`, the link `autocraft login` prints). */
export function Runners() {
  const [sp, setSp] = useSearchParams();
  const code = sp.get("runner")?.trim() || null;
  const closeCode = () => {
    const next = new URLSearchParams(sp);
    next.delete("runner");
    setSp(next, { replace: true });
  };
  const { data, error } = useQuery("runners", (a) => a.runners.list());
  const any = !!data?.runners.length;
  // One page for everyone: the user's Task Runners (if any), then the same setup steps, always shown.
  return (
    <Block dense flush className="mt-4" title={<SectionTitle icon={TerminalWindowIcon}>Task Runners</SectionTitle>}>
      {code && <ApprovalCard key={code} code={code} answering={!!data?.answering} onDone={closeCode} />}
      <ErrorLine error={error?.message} className="px-3 pt-2" />
      {any && (
        <ul>
          {data.runners.map((r) => (
            <RunnerRow key={r.tokenId} r={r} answering={data.answering} />
          ))}
        </ul>
      )}
      {data && !any && (
        <p className="px-3 py-3 text-sm text-ink/65">
          No Task Runner yet.{" "}
          <Link to="/connect/setup" className="text-accent-ink hover:underline">Open the Setup guide</Link>
        </p>
      )}
      <p className={cn("flex flex-wrap gap-x-4 gap-y-1 px-3 py-2 text-xs", any && "border-t border-line")}>
        <Link to="/model-queue" className="text-accent-ink hover:underline">Model call queue</Link>
        <Link to="/agents" className="text-accent-ink hover:underline">Model calls that ran</Link>
      </p>
    </Block>
  );
}

/** Parts of a line joined by middle dots; a line breaks only between parts. */
const dotted = (parts: ReactNode[]) =>
  parts
    .filter((p) => p !== null && p !== false && p !== undefined && p !== "")
    .map((p, i) => (
      <span key={i}>
        {i > 0 && <span className="text-ink/30"> · </span>}
        <span className="whitespace-nowrap">{p}</span>
      </span>
    ));

function RunnerRow({ r, answering }: { r: RunnerInfo; answering: boolean }) {
  const api = useApi();
  const write = useWrite();
  const [open, setOpen] = useState(false);
  const b = readinessBadge(r);
  const isNew = nowMs() - Date.parse(r.createdAt) < NEW_MS;
  const name = r.label ?? `Runner ${r.tokenId}`;
  const setScopes = (s: LoginScopes) => void write.run("scopes", () => api.runners.setScopes(r.tokenId, s));
  return (
    <li className={cn("border-b border-line last:border-0", open && "bg-ink/[0.02]")}>
      <button type="button" aria-expanded={open} aria-label={`${name}: details`} onClick={() => setOpen(!open)} className="flex w-full items-start gap-4 px-3 py-3 text-left hover:bg-ink/[0.03] focus:outline-none focus-visible:bg-ink/[0.04]">
        <div className="min-w-0 flex-1">
          <div className="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium leading-6">{name}</span>
            {isNew && <Badge tone="accent">new</Badge>}
            <Badge tone={b.tone} icon={<span className="inline-block size-1.5 rounded-full bg-current" />}>
              {b.text}
            </Badge>
          </div>
          <div className="mt-1 text-xs leading-5 text-ink/55">
            {dotted([
              r.machine?.hostname,
              r.machine && platform(r.machine.platform),
              r.helperVersion && <span className="num">{r.helperVersion}</span>,
              r.usage && (
                <span className="num" title="Plan used: 5-hour window, weekly">
                  5h {used(r.usage.fiveHour)} · week {used(r.usage.weekly)}
                </span>
              ),
              r.lastSeen ? <>seen <TimeAgo iso={r.lastSeen} /></> : "never seen",
            ])}
          </div>
          {r.lastError && (
            <p className={cn("mt-1 text-xs leading-5 text-bad", open ? "break-words" : "truncate")}>
              {r.lastError.text} <TimeAgo iso={r.lastError.at} className="text-ink/55" />
            </p>
          )}
        </div>
        <span className="flex h-6 shrink-0 items-center gap-3">
          {r.fresh && r.slots !== null && r.busy !== null && (
            <span className="num text-xs text-ink/60" title="Calls running now, of the calls the runner runs at once">
              {r.busy} of {r.slots} busy
            </span>
          )}
          <CaretDownIcon aria-hidden className={cn("text-ink/45 transition-transform duration-fast", open && "rotate-180")} />
        </span>
      </button>
      {/* Outside the button (whose label replaces its content for screen readers), in a live region that is always there. */}
      <p role="status" aria-live="polite" className={cn("px-3 text-xs leading-5 text-ink/65", !r.fresh && "-mt-2 pb-3")}>
        {!r.fresh && (
          <>
            {r.readiness ? "Stopped." : "Logged in, not started yet."} Start it on {r.machine?.hostname ?? "its machine"}: <span className="code">autocraft work</span>
          </>
        )}
      </p>
      {open && (
        <div className="space-y-3 border-t border-line px-3 py-3">
          {r.fresh && r.readiness !== "ready" && r.reason && <p className="text-xs text-ink/65">{r.reason}</p>}
          <div className="flex flex-col gap-y-2 text-sm text-ink/80 sm:flex-row sm:flex-wrap sm:gap-x-6">
            <span className="flex items-center gap-2">
              <Switch on={r.agent} onChange={(on) => setScopes(withAgent(r, on))} label={AGENT} busy={write.busy === "scopes"} />
              {AGENT}
            </span>
            {(answering || r.answer) && (
              <span className="flex items-center gap-2">
                <Switch on={r.answer} onChange={(on) => setScopes(withAnswer(r, on))} label={ANSWER} busy={write.busy === "scopes"} />
                {ANSWER}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <div className="min-w-0 flex-1 text-xs text-ink/55">
              {dotted([
                r.harness && `${r.harness}${r.models.top ? ` · ${r.models.top}` : ""}`,
                r.machine && r.machine.arch,
                `added ${day(r.createdAt)}`,
                `expires ${day(r.expiresAt)}`,
              ])}
            </div>
            <ConfirmButton label="Revoke" confirmLabel="Revoke now" idle="secondary" loading={write.busy === "revoke"} onConfirm={() => void write.run("revoke", () => api.runners.revoke(r.tokenId))} />
          </div>
          <ErrorLine error={write.error} />
        </div>
      )}
    </li>
  );
}

function ApprovalCard({ code, answering, onDone }: { code: string; answering: boolean; onDone: () => void }) {
  const api = useApi();
  const write = useWrite();
  const { data, error } = useQuery(`runner-pending:${code}`, (a) => a.runners.pending(code));
  const [label, setLabel] = useState<string | null>(null);
  const [elsewhere, setElsewhere] = useState(false);
  const [ticks, setTicks] = useState<LoginScopes | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const shown = data !== undefined;
  useEffect(() => {
    if (shown) ref.current?.scrollIntoView({ block: "nearest" });
  }, [shown]);
  if (data === undefined)
    return error ? (
      <div className="flex items-center gap-3 border-b border-line px-3 py-3">
        <ErrorLine error={error.message} className="flex-1" />
        <Button variant="ghost" onClick={onDone}>Close</Button>
      </div>
    ) : null;
  if (data === null)
    return (
      <div ref={ref} className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-3">
        <p className="flex-1 text-sm">
          No Task Runner login is waiting under <span className="code">{code}</span>.
        </p>
        <Button variant="ghost" onClick={onDone}>Close</Button>
      </div>
    );
  const differ = data.ip !== data.yourIp;
  const name = label ?? data.label;
  const scopes = ticks ?? { agent: data.scopes.agent, answer: answering && data.scopes.answer };
  const approve = () =>
    void write.run("approve", async () => {
      await api.runners.approve(code, name.trim() && name.trim() !== data.label ? name.trim() : undefined, { agent: scopes.agent, answer: answering && scopes.answer }, differ && elsewhere);
      onDone();
    });
  const deny = () =>
    void write.run("deny", async () => {
      await api.runners.deny(code);
      onDone();
    });
  const row = (term: string, value: ReactNode) => (
    <>
      <dt className="text-ink/60">{term}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </>
  );
  return (
    <div ref={ref} className="space-y-2 border-b border-line bg-accent/[0.04] px-3 py-3">
      <p className="text-md font-medium">
        Add Task Runner '{data.label}' on {data.machine.hostname} ({platform(data.machine.platform)})?
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {row("Version", <span className="num">{data.helperVersion}</span>)}
        {row("Started", <span className="num">{clock(data.startedAt)} · <TimeAgo iso={data.startedAt} /></span>)}
        {row("Requested from", <span className="code">{data.ip}</span>)}
        {row(
          "This browser",
          <span className="flex flex-wrap items-center gap-2">
            <span className="code">{data.yourIp}</span>
            {differ && <Badge tone="warn">different address</Badge>}
          </span>,
        )}
        {row("Code expires", <span className="num">{clock(data.expiresAt)}</span>)}
        <dt className="self-center text-ink/60">Label</dt>
        <dd className="mt-1 min-w-0">
          <Input value={name} onChange={(e) => setLabel(e.target.value)} maxLength={60} aria-label="Task Runner label" className="w-full sm:max-w-xs" />
        </dd>
      </dl>
      <div className="-mx-2">
        <CheckRow checked={scopes.agent} onChange={(on) => setTicks(withAgent(scopes, on))} title={AGENT} />
        {answering && <CheckRow checked={scopes.answer} onChange={(on) => setTicks(withAnswer(scopes, on))} title={ANSWER} />}
        {differ && <CheckRow checked={elsewhere} onChange={setElsewhere} title="I started this on another machine" />}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={differ && !elsewhere} loading={write.busy === "approve"} onClick={approve}>
          Approve
        </Button>
        <Button loading={write.busy === "deny"} onClick={deny}>
          Deny
        </Button>
      </div>
      <ErrorLine error={write.error} />
    </div>
  );
}
