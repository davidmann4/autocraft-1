import { useEffect, useState } from "react";
import type { DiscordSetup } from "../../api/types";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Switch } from "../../ui/atoms/Switch";
import { Block } from "../../ui/molecules/Block";
import { useWrite } from "../../lib/hooks";

/** The public tracked repos with a switch each for the bot's repo select. A switch flips at once; the server's answer replaces the local value. */
export function DiscordOfferBlock({ offer, filingCount, onSet }: { offer: DiscordSetup["offer"]; filingCount: number; onSet: (repo: string, on: boolean) => Promise<unknown> }) {
  const [local, setLocal] = useState<Record<string, boolean>>({});
  const write = useWrite();
  useEffect(() => setLocal({}), [offer]);
  const on = (r: { name: string; offered: boolean }) => local[r.name] ?? r.offered;
  const used = Math.min(offer.max, offer.repos.filter(on).length + filingCount);
  const flip = (name: string, value: boolean) => {
    setLocal((l) => ({ ...l, [name]: value }));
    void write.run(name, () => onSet(name, value)).then((ok) => { if (!ok) setLocal((l) => { const { [name]: _, ...rest } = l; return rest; }); });
  };
  return (
    <Block className="mt-4" title="Offered in Discord" aside={`${used} of ${offer.max} places used`} flush>
      {offer.repos.length === 0 && <div className="px-4 py-3 text-sm text-ink/55">No public tracked repos.</div>}
      <ul>
        {offer.repos.map((r) => (
          <li key={r.name} className="flex min-h-11 items-center gap-3 border-t border-line px-4 py-1.5 first:border-0">
            <span className="min-w-0 flex-1 truncate text-sm">{r.label}</span>
            <Switch on={on(r)} label={`Offer ${r.label} in Discord`} onChange={(v) => flip(r.name, v)} />
          </li>
        ))}
      </ul>
      <ErrorLine error={write.error} className="px-4 pb-3" />
    </Block>
  );
}
