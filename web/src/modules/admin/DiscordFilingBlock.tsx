import { useState } from "react";
import { LinkSimpleIcon, RobotIcon } from "@phosphor-icons/react";
import type { DiscordFilingAdded, DiscordSetup } from "../../api/types";
import { Badge } from "../../ui/atoms/Badge";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Input } from "../../ui/atoms/Input";
import { TextLink } from "../../ui/atoms/TextLink";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { Tooltip } from "../../ui/atoms/Tooltip";
import { ConfirmButton } from "../../ui/molecules/ConfirmButton";
import { Block } from "../../ui/molecules/Block";
import { useWrite } from "../../lib/hooks";
import { cn } from "../../ui/cn";

/** Public repos of other owners the bot offers without tracking them, each with how it files there now: the list, remove, and an owner/name field to add one. */
export function DiscordFilingBlock({ repos, onAdd, onRemove }: { repos: DiscordSetup["filingRepos"]; onAdd: (repo: string) => Promise<DiscordFilingAdded>; onRemove: (repo: string) => Promise<unknown> }) {
  const [v, setV] = useState("");
  const [added, setAdded] = useState<DiscordFilingAdded["added"] | null>(null);
  const write = useWrite();
  const add = async () => {
    setAdded(null);
    if (await write.run("add", async () => setAdded((await onAdd(v.trim())).added))) setV("");
  };
  return (
    <Block className="mt-4" title="Filing-only repos" aside={`${repos.length}`} flush>
      {repos.length === 0 && <div className="px-4 py-3 text-sm text-ink/55">No filing-only repos.</div>}
      <ul>
        {repos.map((r) => {
          const slug = `${r.owner}/${r.name}`;
          return (
            <li key={slug} className="flex min-h-11 items-center gap-3 border-t border-line px-4 py-1.5 first:border-0">
              <div className="min-w-0 flex-1">
                <TextLink href={`https://github.com/${slug}`} className="block truncate text-sm">{slug}</TextLink>
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-2xs text-ink/45">{r.addedBy} · <TimeAgo iso={r.addedAt} /></span>
                  <ModeBadge mode={r.mode} why={r.why} className="sm:hidden" />
                </div>
              </div>
              <ModeBadge mode={r.mode} why={r.why} className="max-sm:hidden" />
              <ConfirmButton label="Remove" confirmLabel="Confirm remove" loading={write.busy === slug} onConfirm={() => void write.run(slug, () => onRemove(slug))} target={slug} />
            </li>
          );
        })}
      </ul>
      <form className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <Input value={v} onChange={(e) => setV(e.target.value)} maxLength={200} placeholder="owner/name" aria-label="Repo to file into (owner/name)" className="w-full sm:w-72" />
        <Button type="submit" variant="primary" disabled={write.busy === "add" || !/^[^/\s]+\/[^/\s]+$/.test(v.trim())} className="max-md:h-11 max-md:w-full">
          Add
        </Button>
        <ErrorLine error={write.error} className="basis-full" />
        <div role="status" className="basis-full text-sm text-ink/70 empty:hidden">
          {added && (added.mode === "submit" ? `Added ${added.owner}/${added.name}: Submit for me.` : `Added ${added.owner}/${added.name}, link only: ${added.why ?? "the GitHub App does not cover it."}`)}
        </div>
      </form>
    </Block>
  );
}

/** How the bot files into the repo now: as the GitHub App, or only through the prefilled GitHub link, with why on hover and focus. On phones it sits on the meta line, so the repo name keeps the row's width. */
function ModeBadge({ mode, why, className }: { mode: DiscordSetup["filingRepos"][number]["mode"]; why: string | null; className?: string }) {
  if (mode === "submit") return <Badge tone="ok" icon={<RobotIcon aria-hidden size={12} />} className={className}>Submit for me</Badge>;
  return (
    <Tooltip content={why}>
      <span tabIndex={why ? 0 : undefined} aria-label={why ? `Link only: ${why}` : undefined} className={cn("rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-ink", className)}>
        <Badge icon={<LinkSimpleIcon aria-hidden size={12} />}>Link only</Badge>
      </span>
    </Tooltip>
  );
}
