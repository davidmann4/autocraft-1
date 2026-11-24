import { Fragment, useEffect, useState, type ReactNode } from "react";
import { useApi, useQuery } from "../../api/client";
import type { DiscordSetup } from "../../api/types";
import type { ViewProps } from "../../registry/types";
import { DiscordUsageBlock } from "./DiscordUsageBlock";
import { DiscordFilingBlock } from "./DiscordFilingBlock";
import { DiscordOfferBlock } from "./DiscordOfferBlock";
import { Badge, type Tone } from "../../ui/atoms/Badge";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Input } from "../../ui/atoms/Input";
import { Select } from "../../ui/atoms/Select";
import { Switch } from "../../ui/atoms/Switch";
import { TextLink } from "../../ui/atoms/TextLink";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { Avatar } from "../../ui/atoms/Avatar";
import { ConfirmButton } from "../../ui/molecules/ConfirmButton";
import { Block } from "../../ui/molecules/Block";
import { DisclosureButton, useRememberedOpen } from "../../ui/molecules/DisclosureButton";
import { Facts } from "../../ui/molecules/Facts";
import { Page } from "../../ui/organisms/Page";
import { useWrite } from "../../lib/hooks";

const STATE: Record<DiscordSetup["state"], [string, Tone]> = {
  off: ["Off", "neutral"], connecting: ["Connecting", "warn"], connected: ["Connected", "ok"], reconnecting: ["Reconnecting", "warn"], failed: ["Failed", "bad"],
};

function GuildSection({ guildId, name, count, defaultOpen, children }: { guildId: string; name: string; count: number; defaultOpen: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = `discord-guild-${guildId}`;
  return (
    <div className="border-b border-line last:border-0">
      <DisclosureButton open={open} onToggle={setOpen} controls={id} className="bg-ink/[0.03] text-ink">
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
          {name}
          <span className="num text-2xs font-normal text-ink/45">{guildId}</span>
        </span>
        <span className="num shrink-0 text-xs font-normal text-ink/55">{count} {count === 1 ? "channel" : "channels"}</span>
      </DisclosureButton>
      {open && <div id={id}>{children}</div>}
    </div>
  );
}

export function DiscordView(_: ViewProps) {
  const { data, error, refetch } = useQuery("discord-setup", (api) => api.discord.setup());
  const api = useApi();
  const write = useWrite();
  const [showAll, setShowAll] = useRememberedOpen("discord-channels");
  const inUse = data ? data.channels.filter((c) => c.watched || c.defaultRepo !== null) : [];
  const shown = data ? (showAll ? data.channels : inUse) : [];
  const guilds = [...new Set(shown.map((c) => c.guildId))];
  return (
    <Page title="Discord">
      <ErrorLine error={error?.message ?? write.error} className="mt-3" />
      {data && (
        <>
          <Block className="mt-4" title="Connection" aside={<Badge tone={STATE[data.state][1]}>{STATE[data.state][0]}</Badge>}>
            <Facts
              rows={[
                ["State since", data.at ? <TimeAgo key="at" iso={data.at} /> : null],
                ["Detail", data.detail],
                ["Privacy page", <TextLink key="p" href={data.privacyPath}>{data.privacyPath}</TextLink>],
              ]}
            />
            {data.state === "off" && <p className="mt-2 text-sm text-ink/55">The runner has no Discord token file.</p>}
          </Block>
          <Block className="mt-4" title="Channels" aside={`${data.channels.filter((c) => c.watched).length} watched`} flush>
            {data.channels.length === 0 && <div className="px-4 py-3 text-sm text-ink/55">The bot has reported no channels.</div>}
            {data.channels.length > 0 && !showAll && inUse.length === 0 && <div className="px-4 py-3 text-sm text-ink/55">No channel is watched or has a default repo.</div>}
            <div id="discord-channel-list">
            {guilds.map((g) => (
              <GuildSection key={`${g}:${showAll}`} guildId={g} name={data.channels.find((c) => c.guildId === g)?.guildName ?? "Server"} count={data.channels.filter((c) => c.guildId === g).length} defaultOpen={!showAll}>
                <ul>
                  {shown.filter((c) => c.guildId === g).map((c, i, all) => (
                    <Fragment key={c.channelId}>
                    {c.category !== null && c.category !== (all[i - 1]?.category ?? null) && (
                      <li className="border-t border-line bg-ink/[0.02] px-4 pb-1 pt-2 text-2xs font-medium uppercase tracking-wide text-ink/45 first:border-0">{c.category}</li>
                    )}
                    <li className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-1.5 first:border-0">
                      <div className="min-w-0 max-md:basis-full md:flex-1">
                        <div className="truncate text-sm">#{c.name ?? "unnamed"}</div>
                        <div className="num truncate text-2xs text-ink/45">{c.channelId}</div>
                      </div>
                      <Select
                        size="sm"
                        value={c.defaultRepo ?? ""}
                        disabled={write.busy === `repo:${c.channelId}`}
                        aria-label={`Default repo for new issues from #${c.name ?? c.channelId}`}
                        onChange={(e) => void write.run(`repo:${c.channelId}`, () => api.discord.setChannelRepo(c.channelId, e.target.value || null)).then(() => refetch())}
                        className="max-md:flex-1 md:max-w-40"
                      >
                        <option value="">No default repo</option>
                        {data.repos.map((r) => <option key={r} value={r}>{r}</option>)}
                      </Select>
                      <Switch on={c.watched} label={`Watch #${c.name ?? c.channelId}`} busy={write.busy === c.channelId} onChange={(on) => void write.run(c.channelId, () => api.discord.setChannel(c.channelId, on)).then(() => refetch())} />
                    </li>
                    </Fragment>
                  ))}
                </ul>
              </GuildSection>
            ))}
            </div>
            {inUse.length < data.channels.length ? (
              <DisclosureButton open={showAll} onToggle={setShowAll} controls="discord-channel-list" className="border-t border-line">
                {showAll ? "Show fewer" : `Show all channels (${data.channels.length})`}
              </DisclosureButton>
            ) : null}
          </Block>
          <DiscordOfferBlock offer={data.offer} filingCount={data.filingRepos.length} onSet={(r, on) => api.discord.setOffer(r, on).then(() => refetch())} />
          <DiscordFilingBlock repos={data.filingRepos} onAdd={(r) => api.discord.addFilingRepo(r).then((x) => { void refetch(); return x; })} onRemove={(r) => api.discord.removeFilingRepo(r).then(() => refetch())} />
          <DiscordUsageBlock usage={data.usage} />
          <LinksBlock links={data.links} busy={write.busy} onRemove={(id) => write.run(id, () => api.discord.removeLink(id)).then(() => refetch())} />
          <Block className="mt-4" title="Reactions">
            <div className="flex min-h-11 items-center gap-3">
              <span className="min-w-0 flex-1 text-sm">React to recorded messages</span>
              <Switch on={data.reactOn} label="React to recorded messages" busy={write.busy === "react"} onChange={(on) => void write.run("react", () => api.discord.setReact(on)).then(() => refetch())} />
            </div>
            <EmojiField value={data.reactEmoji} busy={write.busy === "emoji"} onSave={(v) => write.run("emoji", () => api.discord.setReactEmoji(v)).then(() => refetch())} />
          </Block>
          <ContactBlock contact={data.contact} onSave={(c) => write.run("contact", () => api.discord.setContact(c)).then(() => refetch())} busy={write.busy === "contact"} />
        </>
      )}
    </Page>
  );
}

const EMOJI_OK = /^(?:[A-Za-z0-9_]{2,32}|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic})*)$/u;

function EmojiField({ value, onSave, busy }: { value: string; onSave: (v: string) => void; busy: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const bad = v.trim() !== "" && !EMOJI_OK.test(v.trim());
  return (
    <form className="flex flex-wrap items-center gap-2 border-t border-line pt-3" onSubmit={(e) => { e.preventDefault(); if (!bad) onSave(v.trim()); }}>
      <label htmlFor="react-emoji" className="min-w-0 flex-1 text-sm max-md:basis-full">Reaction emoji</label>
      <Input id="react-emoji" value={v} onChange={(e) => setV(e.target.value)} maxLength={40} aria-invalid={bad} aria-describedby={bad ? "react-emoji-err" : undefined} className="w-full sm:w-56" />
      <Button type="submit" variant="primary" disabled={busy || bad || v.trim() === "" || v.trim() === value} className="max-md:h-11 max-md:w-full">
        Save
      </Button>
      {bad && <div id="react-emoji-err" role="alert" className="basis-full text-xs text-bad">Use a custom emoji name (2-32 letters, digits or underscores) or one Unicode emoji.</div>}
    </form>
  );
}

function ContactBlock({ contact, onSave, busy }: { contact: string; onSave: (c: string) => void; busy: boolean }) {
  const [v, setV] = useState(contact);
  useEffect(() => setV(contact), [contact]);
  return (
    <Block className="mt-4" title="Deletion requests">
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); onSave(v); }}>
        <Input value={v} onChange={(e) => setV(e.target.value)} maxLength={300} placeholder="Contact shown on the privacy page" aria-label="Contact for deletion requests" className="w-full sm:w-96" />
        <Button type="submit" variant="primary" disabled={busy || v.trim() === contact} className="max-md:h-11 max-md:w-full">
          Save
        </Button>
      </form>
    </Block>
  );
}

function LinksBlock({ links, busy, onRemove }: { links: DiscordSetup["links"]; busy: string | null; onRemove: (id: string) => void }) {
  return (
    <Block className="mt-4" title="Linked accounts" aside={`${links.length}`} flush>
      {links.length === 0 && <div className="px-4 py-3 text-sm text-ink/55">No Discord account is linked.</div>}
      <ul>
        {links.map((l) => (
          <li key={l.id} className="flex min-h-11 items-center gap-3 border-t border-line px-4 py-1.5 first:border-0">
            <Avatar login={l.login} size={20} />
            <span className="min-w-0 flex-1 truncate text-sm">{l.login}</span>
            <span className="text-2xs text-ink/45"><TimeAgo iso={l.linkedAt} /></span>
            <ConfirmButton label="Remove" confirmLabel="Confirm remove" loading={busy === l.id} onConfirm={() => onRemove(l.id)} />
          </li>
        ))}
      </ul>
    </Block>
  );
}
