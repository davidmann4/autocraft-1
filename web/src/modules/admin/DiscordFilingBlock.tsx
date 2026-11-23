import { useState } from "react";
import type { DiscordSetup } from "../../api/types";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Input } from "../../ui/atoms/Input";
import { TextLink } from "../../ui/atoms/TextLink";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { ConfirmButton } from "../../ui/molecules/ConfirmButton";
import { Block } from "../../ui/molecules/Block";
import { useWrite } from "../../lib/hooks";

/** Public repos of other owners the bot files into without tracking them: the list, remove, and an owner/name field to add one. */
export function DiscordFilingBlock({ repos, onAdd, onRemove }: { repos: DiscordSetup["filingRepos"]; onAdd: (repo: string) => Promise<unknown>; onRemove: (repo: string) => Promise<unknown> }) {
  const [v, setV] = useState("");
  const write = useWrite();
  const add = async () => {
    if (await write.run("add", () => onAdd(v.trim()))) setV("");
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
                <div className="truncate text-2xs text-ink/45">{r.addedBy} · <TimeAgo iso={r.addedAt} /></div>
              </div>
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
      </form>
    </Block>
  );
}
