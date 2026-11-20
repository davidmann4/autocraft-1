import { PlugsConnectedIcon, PlusIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { useApi, useQuery } from "../../api/client";
import type { McpToken } from "../../api/types";
import type { ViewProps } from "../../registry/types";
import { Badge } from "../../ui/atoms/Badge";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Input } from "../../ui/atoms/Input";
import { Switch } from "../../ui/atoms/Switch";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { Block } from "../../ui/molecules/Block";
import { CodeBlock } from "../../ui/molecules/CodeBlock";
import { ConfirmButton } from "../../ui/molecules/ConfirmButton";
import { Page } from "../../ui/organisms/Page";
import { day } from "../../lib/format";
import { useWrite } from "../../lib/hooks";
import { MySettings } from "./MySettings";
import { Runners } from "./Runners";
import { RunnerGuide } from "./Setup";
import { Fold } from "./Fold";
import { SectionTitle, touch } from "./SectionTitle";

/** The command that adds the MCP Connector to Claude Code; other clients take the URL and header the same way. */
const claudeCommand = (url: string, token: string) => `claude mcp add --transport http autocraft ${url} --header "Authorization: Bearer ${token}"`;
const jsonConfig = (url: string, token: string) => JSON.stringify({ mcpServers: { autocraft: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
/** The Connect page's views, switched with chips as on the merge queue; the setup guide is a view of its own. */
const TABS = [
  ["", "Overview"],
  ["setup", "Setup guide"],
] as const;

export function ConnectView({ user }: ViewProps) {
  const { tab = "" } = useParams();
  const [sp] = useSearchParams();
  const local = user.role !== "viewer" && user.inference === "user-local";
  const runners = useQuery("runners", (a) => a.runners.list(), { enabled: local });
  if (!TABS.some(([t]) => t === tab) || (tab && !local)) return <Navigate to="/connect" replace />;
  if (local && !runners.data && !runners.error) return <Page title="Connect your Agents"><></></Page>;
  // No Task Runner yet: the setup guide and the MCP Connector, nothing else; a login waiting for approval (`?runner=CODE`) still shows its card.
  if (local && runners.data?.runners.length === 0 && !sp.get("runner")) {
    return (
      <Page title="Connect your Agents">
        <RunnerGuide />
        <Connector user={user} />
      </Page>
    );
  }
  return (
    <Page title="Connect your Agents">
      {local && (
        <div role="tablist" aria-label="Connect" className="mt-4 flex flex-wrap items-center gap-1">
          {TABS.map(([t, label]) => (
            // The device-login link (`?runner=CODE`) stays on the overview, where it is approved.
            <Link key={t} role="tab" aria-selected={tab === t} data-active={tab === t} to={t ? `/connect/${t}` : `/connect${sp.size && !tab ? `?${sp}` : ""}`} replace className="chip max-md:h-11">
              {label}
            </Link>
          ))}
        </div>
      )}
      {tab === "setup" ? (
        <RunnerGuide />
      ) : (
        <>
          {local && <MySettings />}
          {local && <Runners />}
          <Connector user={user} />
        </>
      )}
    </Page>
  );
}

function Connector({ user }: Pick<ViewProps, "user">) {
  const api = useApi();
  const write = useWrite();
  const { data, error } = useQuery("mcp-tokens", (a) => a.mcp.tokens());
  const [form, setForm] = useState(false);
  const [label, setLabel] = useState("");
  const [answer, setAnswer] = useState(false);
  const [made, setMade] = useState<{ id: number; token: string } | null>(null);
  const url = `${location.origin}${data?.path ?? "/mcp"}`;
  const tokens = data?.tokens.filter((t) => t.kind === "connector") ?? [];
  const full = !!data && tokens.length >= data.max;
  const viewer = user.role === "viewer";
  const settles = user.role === "operator" || (user.role === "maintainer" && user.maintainerWrites);

  const close = () => {
    setForm(false);
    setLabel("");
    setAnswer(false);
  };
  const create = () =>
    void write.run("create", async () => {
      const r = await api.mcp.create(label, settles && !!data?.answering && answer);
      setMade({ id: r.id, token: r.token });
      close();
    });

  return (
    <Block
      dense
      flush
      className="mt-4"
      title={<SectionTitle icon={PlugsConnectedIcon}>MCP Connector</SectionTitle>}
      aside={
        data && (
          <span className="flex items-center gap-3">
            <span className="num">
              {tokens.length} of {data.max}
            </span>
            {!viewer && !form && (
              <Button size="sm" icon={PlusIcon} disabled={full} title={full ? "Revoke a token to make another" : undefined} onClick={() => { setMade(null); setForm(true); }} className={touch}>
                New token
              </Button>
            )}
          </span>
        )
      }
    >
      {form && (
        <form
          className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-ink/[0.02] px-3 py-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <Input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} placeholder="Label, e.g. laptop" aria-label="Token label" className="min-w-[12rem] flex-1 sm:max-w-xs" />
          {settles && data?.answering && (
            <span className="flex items-center gap-2 text-sm text-ink/80">
              <Switch on={answer} onChange={setAnswer} label="Can answer decisions" />
              Can answer decisions
            </span>
          )}
          <span className="flex gap-2 max-sm:ml-auto">
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={full} loading={write.busy === "create"}>
              Create
            </Button>
          </span>
        </form>
      )}
      <ErrorLine error={error?.message ?? write.error} className="px-3 pt-2" />
      {made && (
        <div className="space-y-2 border-b border-line bg-accent/[0.04] px-3 py-2.5">
          <div className="flex items-center gap-2">
            <p className="flex-1 text-sm font-medium">Copy it now: the token is shown only this once.</p>
            <Button size="sm" variant="ghost" onClick={() => setMade(null)} className={touch}>
              Done
            </Button>
          </div>
          <Snippets url={url} token={made.token} />
        </div>
      )}
      {data && <Tokens tokens={tokens} write={write} fresh={made?.id ?? null} />}
      {data && !made && (
        <Fold className="border-t border-line px-3 py-1" title="How to connect">
          <div className="pb-2 pt-1">
            <Snippets url={url} token="<token>" />
          </div>
        </Fold>
      )}
    </Block>
  );
}

/** The command that adds the MCP Connector to Claude Code, and the JSON other clients take. */
function Snippets({ url, token }: { url: string; token: string }) {
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <div className="text-xs font-medium text-ink/65">Claude Code</div>
        <CodeBlock compact title="Claude Code command" text={claudeCommand(url, token)} />
      </div>
      <div className="space-y-1">
        <div className="text-xs font-medium text-ink/65">Other MCP clients (JSON config)</div>
        <CodeBlock compact title="JSON config" text={jsonConfig(url, token)} />
      </div>
    </div>
  );
}

function Tokens({ tokens, write, fresh }: { tokens: McpToken[]; write: ReturnType<typeof useWrite>; fresh: number | null }) {
  const api = useApi();
  if (!tokens.length) return null;
  return (
    <ul>
      {tokens.map((t) => (
        <li key={t.id} className="flex items-center gap-3 border-b border-line px-3 py-1.5 last:border-0">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5">
            <span className="flex items-center gap-2 font-medium">
              {t.label ?? <span className="text-ink/40">no label</span>}
              {t.canAnswer && <Badge>answers decisions</Badge>}
              {t.id === fresh && <Badge tone="accent">new</Badge>}
            </span>
            <span className="text-xs text-ink/55">
              made {day(t.createdAt)} · {t.lastUsedAt ? <>used <TimeAgo iso={t.lastUsedAt} /></> : "never used"} · expires {day(t.expiresAt)}
            </span>
          </div>
          <ConfirmButton label="Revoke" confirmLabel="Revoke now" loading={write.busy === `revoke:${t.id}`} onConfirm={() => void write.run(`revoke:${t.id}`, () => api.mcp.revoke(t.id))} />
        </li>
      ))}
    </ul>
  );
}
