import { useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useApi, useQuery } from "../../api/client";
import type { GithubAppStatus, GithubSetupLink } from "../../api/types";
import type { ViewProps } from "../../registry/types";
import { Badge } from "../../ui/atoms/Badge";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Input } from "../../ui/atoms/Input";
import { TextLink } from "../../ui/atoms/TextLink";
import { day } from "../../lib/format";
import { Block } from "../../ui/molecules/Block";
import { ConfirmButton } from "../../ui/molecules/ConfirmButton";
import { Segmented } from "../../ui/molecules/Segmented";
import { useUser } from "../../shell/UserContext";
import { Facts } from "../../ui/molecules/Facts";
import { Page } from "../../ui/organisms/Page";

/** Starts the GitHub App user authorization for the signed-in operator and returns to this page. The session is not touched. */
const authorizeHref = (): string => `/auth/authorize-app?${new URLSearchParams({ return_to: window.location.pathname + window.location.search })}`;

const IDENTITY_LABEL = { box: "Box account", app: "GitHub App" } as const;
const IDENTITY_LINE = {
  box: "GitHub writes use the server's own GitHub account; dashboard sign-in uses the OAuth App.",
  app: "GitHub writes are made by the GitHub App, and answers by the person who gave them; dashboard sign-in uses the GitHub App.",
} as const;

export function GithubAppView(_: ViewProps) {
  const { data, error, refetch } = useQuery("github-app", (api) => api.githubApp.status());
  return (
    <Page title="GitHub App">
      <ErrorLine error={error?.message} className="mt-3" />
      {data && (
        <>
          <IdentityBlock s={data} onChange={refetch} />
          <AppBlock s={data} onChange={refetch} />
          <SetupLinks links={data.links} onChange={refetch} />
          {data.app && <AllowedOwners s={data} onChange={refetch} />}
          {data.app && <Installations s={data} onChange={refetch} />}
        </>
      )}
    </Page>
  );
}

/** The one instance-wide switch. Switching ends every session, so the page goes to sign-in afterwards. */
function IdentityBlock({ s, onChange }: { s: GithubAppStatus; onChange: () => void }) {
  const api = useApi();
  const operator = useUser().role === "operator";
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<"box" | "app" | null>(null);
  const choose = async (identity: "box" | "app") => {
    setError(null);
    try {
      const done = await api.githubApp.setIdentity(identity);
      if (done.signIn) window.location.assign(done.signIn);
      else onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Block className="mt-4" title="GitHub identity">
      <div className="px-4 py-3">
        {operator ? (
          <div className="flex flex-wrap items-center gap-3">
            <Segmented label="GitHub identity" value={pick ?? s.identity} options={(["box", "app"] as const).map((v) => ({ value: v, label: IDENTITY_LABEL[v] }))} onChange={(v) => setPick(v === s.identity ? null : v)} />
            {pick && pick !== s.identity && <ConfirmButton label={`Switch to ${IDENTITY_LABEL[pick]}`} confirmLabel="Switch and end every session" idle="secondary" onConfirm={() => void choose(pick)} />}
          </div>
        ) : (
          <Badge tone={s.identity === "app" ? "ok" : undefined}>{IDENTITY_LABEL[s.identity]}</Badge>
        )}
        <p className="mt-2 text-sm text-ink/70">{IDENTITY_LINE[s.identity]}</p>
        <ErrorLine error={error} className="mt-2" />
      </div>
    </Block>
  );
}

function AppBlock({ s, onChange }: { s: GithubAppStatus; onChange: () => void }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      setRemoved((await api.githubApp.remove()).settingsUrl);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Block className="mt-4" title="App" aside={<Badge tone={s.configured ? "ok" : "neutral"}>{s.configured ? "Registered" : "Not registered"}</Badge>}>
      <div className="px-4 py-3">
        {s.app ? (
          <>
            <Facts
              rows={[
                ["Name", s.app.name],
                ["Slug", <code key="slug">{s.app.slug}</code>],
                ...(s.app.mention ? [["Mention name", <code key="mention">{s.app.mention}</code>] as [string, ReactNode]] : []),
                ["App id", <code key="id">{s.app.id}</code>],
                ["Acts as you", s.authorized ? "Authorized" : "Not authorized"],
              ]}
            />
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
              <a href={authorizeHref()} className="text-accent-ink hover:underline">
                {s.authorized ? "Authorize again" : "Authorize AutoCraft to act as you"}
              </a>
              <TextLink href={s.app.installUrl}>Install</TextLink>
              <TextLink href={s.app.transferUrl}>Transfer</TextLink>
              <ConfirmButton className="ml-auto" label="Remove" confirmLabel="Remove app" loading={busy} onConfirm={() => void remove()} />
            </div>
            <ErrorLine error={error} className="mt-2" />
          </>
        ) : (
          <>
            {removed && (
              <div className="mb-3 text-sm">
                <TextLink href={removed}>Delete it on GitHub</TextLink>
              </div>
            )}
            <RegisterForm s={s} />
          </>
        )}
      </div>
    </Block>
  );
}

function RegisterForm({ s }: { s: GithubAppStatus }) {
  const [name, setName] = useState(s.defaultName);
  const [org, setOrg] = useState("");
  return (
    <>
      <form method="post" action="/auth/github-app/start" className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="csrf" value={s.csrf} />
        <Input name="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={34} aria-label="App name" className="w-full sm:w-52" />
        <Input name="org" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Organization (optional)" aria-label="Organization" className="w-full sm:w-52" />
        {s.keysUnreadable && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="replace_unreadable" value="1" />
            Replace the stored keys that cannot be read
          </label>
        )}
        <Button type="submit" variant="primary" disabled={!s.canRegister || !name.trim()} className="max-md:h-11 max-md:w-full">
          Register on GitHub
        </Button>
      </form>
    </>
  );
}

/** Run one write at a time with its busy key and error, then reread the page. */
function useWrite(onChange: () => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (key: string, f: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await f();
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, run };
}

/** The accounts the app may be installed on; an installation on any other account is removed. An empty list enforces nothing. */
function AllowedOwners({ s, onChange }: { s: GithubAppStatus; onChange: () => void }) {
  const api = useApi();
  const w = useWrite(onChange);
  const [login, setLogin] = useState("");
  const on = s.allowedOwners.length > 0;
  return (
    <Block className="mt-4" title="Allowed owners" aside={<Badge tone={on ? "ok" : "neutral"}>{on ? "On" : "Off (no owners listed)"}</Badge>}>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void w.run("allow", async () => {
            await api.githubApp.allowOwner(login.trim());
            setLogin("");
          });
        }}
      >
        <Input value={login} onChange={(e) => setLogin(e.target.value)} placeholder="GitHub account" aria-label="GitHub account" maxLength={39} className="w-full sm:w-52" />
        <Button type="submit" variant="primary" loading={w.busy === "allow"} disabled={!login.trim()} className="max-md:h-11 max-md:w-full">
          Allow
        </Button>
      </form>
      <ErrorLine error={w.error} className="mt-2" />
      {on && (
        <ul className="mt-3">
          {s.allowedOwners.map((o) => (
            <li key={o.login} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line py-2 first:border-0">
              <span className="min-w-0 break-all text-sm font-medium">{o.login}</span>
              <span className="text-xs text-ink/55">
                {o.addedBy} · {day(o.addedAt)}
              </span>
              {o.kept ? (
                <Badge tone="ok" className="ml-auto">
                  Protected
                </Badge>
              ) : (
                <ConfirmButton
                  className="ml-auto"
                  label="Remove"
                  confirmLabel={`Remove ${o.login}`}
                  loading={w.busy === `remove:${o.login}`}
                  onConfirm={() => void w.run(`remove:${o.login}`, () => api.githubApp.removeOwner(o.login))}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </Block>
  );
}

function Installations({ s, onChange }: { s: GithubAppStatus; onChange: () => void }) {
  const api = useApi();
  const w = useWrite(onChange);
  return (
    <Block className="mt-4" title="Installations">
      <ErrorLine error={s.error ?? w.error} className="px-4 pt-3" />
      {s.installations.length === 0 && !s.error && <div className="px-4 py-3 text-sm text-ink/55">Not installed anywhere yet.</div>}
      <ul>
        {s.installations.map((i) => (
          <li key={i.id} className="border-b border-line px-4 py-3 last:border-0">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="min-w-0 break-all font-medium">{i.owner}</span>
              {i.type && <Badge>{i.type}</Badge>}
              <Badge>{i.selection === "all" ? "All repos" : `${i.repos.length} repos`}</Badge>
              {i.createdAt && <span className="text-xs text-ink/55">installed {day(i.createdAt)}</span>}
              {i.allowed || i.protected ? (
                <Badge tone="ok" className="ml-auto">
                  {i.allowed ? "Allowed" : "Protected"}
                </Badge>
              ) : (
                <Button size="sm" variant="secondary" className="ml-auto max-md:h-11" loading={w.busy === i.owner} onClick={() => void w.run(i.owner, () => api.githubApp.allowOwner(i.owner))}>
                  Allow
                </Button>
              )}
            </div>
            <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink/70">
              {i.repos.map((r) => (
                <li key={r} className="min-w-0 break-all">
                  {r}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </Block>
  );
}

function SetupLinks({ links, onChange }: { links: GithubSetupLink[]; onChange: () => void }) {
  const api = useApi();
  const [org, setOrg] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ org: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const run = async (key: string, f: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await f();
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Block className="mt-4" title="Setup links">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run("create", async () => {
            const made = await api.githubApp.createLink(org.trim());
            setFresh({ org: made.link.org, url: made.url.startsWith("/") ? `${location.origin}${made.url}` : made.url });
            setCopied(false);
            setOrg("");
          });
        }}
      >
        <Input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Organization" aria-label="Organization" maxLength={39} className="w-full sm:w-52" />
        <Button type="submit" variant="primary" loading={busy === "create"} disabled={!org.trim()} className="max-md:h-11 max-md:w-full">
          Create link
        </Button>
      </form>
      <ErrorLine error={error} className="mt-2" />
      {fresh && (
        <div className="mt-3 rounded border border-line bg-ink/[0.03] p-3">
          <div className="text-xs text-ink/55">{fresh.org}</div>
          <code className="mt-1 block break-all text-xs">{fresh.url}</code>
          <Button
            size="sm"
            variant="secondary"
            icon={copied ? CheckIcon : CopyIcon}
            className="mt-2 max-md:h-11 max-md:w-full"
            onClick={() => void navigator.clipboard.writeText(fresh.url).then(() => setCopied(true))}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      )}
      <ul className="mt-3">
        {links.map((l) => (
          <li key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line py-2 first:border-0">
            <span className="min-w-0 break-all text-sm font-medium">{l.org}</span>
            <span className="text-xs text-ink/55">
              {l.createdBy} · expires {day(l.expiresAt)}
            </span>
            <ConfirmButton className="ml-auto" label="Revoke" confirmLabel="Revoke link" loading={busy === `revoke:${l.id}`} onConfirm={() => void run(`revoke:${l.id}`, async () => void (await api.githubApp.revokeLink(l.id)))} />
          </li>
        ))}
      </ul>
    </Block>
  );
}
