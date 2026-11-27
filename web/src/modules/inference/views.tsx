import { useState } from "react";
import { XIcon } from "@phosphor-icons/react";
import { useApi, useQuery } from "../../api/client";
import type { InferenceEffort, InferenceSettings, InferenceTier } from "../../api/types";
import type { ViewProps } from "../../registry/types";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Input } from "../../ui/atoms/Input";
import { Select } from "../../ui/atoms/Select";
import { Block } from "../../ui/molecules/Block";
import { Page } from "../../ui/organisms/Page";
import { useWrite } from "../../lib/hooks";
import { clock } from "../../lib/format";

const TIERS: { tier: InferenceTier; label: string }[] = [
  { tier: "top", label: "Top" },
  { tier: "mid", label: "Mid" },
  { tier: "small", label: "Small" },
];
const EFFORTS: InferenceEffort[] = ["low", "medium", "high", "xhigh", "max"];
const FAMILY = /^[a-z0-9][a-z0-9.-]{0,39}$/;

export function InferenceView(_: ViewProps) {
  const api = useApi();
  const write = useWrite();
  const { data, error } = useQuery("inference", (a) => a.inference.get());
  if (!data) return <Page title="Inference"><ErrorLine error={error?.message} className="mt-3" /></Page>;

  const saveModels = (models: InferenceSettings["models"]) => write.run("models", () => api.inference.put({ models }));

  const saveEffort = (tier: InferenceTier, effort: InferenceEffort | null) => write.run("effort", () => api.inference.put({ minEffort: { [tier]: effort } }));

  return (
    <Page title="Inference">
      <ErrorLine error={write.error} className="mt-3" />
      <Jev />
      <Block className="mt-4" title="Accepted models" aside="model families and lowest effort per tier">
        <ul className="divide-y divide-line">
          {TIERS.map(({ tier, label }) => (
            <Families key={tier} label={label} families={data.models[tier]} busy={write.busy === "models" || write.busy === "effort"} onChange={(list) => saveModels({ ...data.models, [tier]: list })} minEffort={data.minEffort[tier] ?? null} onMinEffort={(e) => saveEffort(tier, e)} />
          ))}
        </ul>
      </Block>
    </Page>
  );
}

/** Jev runs on the host beside the Task Runners; off or unavailable, Haiku does its work. */
function Jev() {
  const api = useApi();
  const write = useWrite();
  const q = useQuery("inference-jev", (a) => a.inference.jev());
  if (!q.data) return <ErrorLine error={q.error?.message} className="mt-3" />;
  const { enabled, unavailable } = q.data;
  return (
    <Block className="mt-4" title="Jev">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <span className="min-w-0 flex-1">{unavailable ? `Unavailable (${unavailable.reason}) since ${clock(unavailable.since)}: Haiku does Jev's work` : "In use"}</span>
        <Button size="sm" loading={write.busy === "jev"} onClick={() => void write.run("jev", () => api.inference.setJev(!enabled)).then((ok) => ok && q.refetch())} className="max-md:h-11">
          {enabled ? "Turn Jev off" : "Turn Jev on"}
        </Button>
      </div>
      <ErrorLine error={write.error} className="mt-2" />
    </Block>
  );
}

function Families({ label, families, busy, onChange, minEffort, onMinEffort }: { label: string; families: string[]; busy: boolean; onChange: (list: string[]) => Promise<boolean>; minEffort: InferenceEffort | null; onMinEffort: (e: InferenceEffort | null) => Promise<boolean> }) {
  const [text, setText] = useState("");
  const name = text.trim().toLowerCase();
  const ok = FAMILY.test(name) && !families.includes(name);
  const add = () => {
    if (!ok) return;
    void onChange([...families, name]).then((saved) => saved && setText(""));
  };
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
      <span className="w-14 text-sm font-medium">{label}</span>
      <ul className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" aria-label={`${label} model families`}>
        {families.map((f) => (
          <li key={f} className="code inline-flex h-7 items-center gap-1 rounded-full border border-line-strong bg-raised pl-2.5 pr-1 text-xs max-md:h-9">
            {f}
            <button
              type="button"
              aria-label={`Remove ${f} from ${label}`}
              disabled={busy || families.length === 1}
              onClick={() => void onChange(families.filter((x) => x !== f))}
              className="inline-flex size-5 items-center justify-center rounded-full text-ink/55 hover:bg-ink/10 hover:text-ink disabled:opacity-30 max-md:size-7"
            >
              <XIcon />
            </button>
          </li>
        ))}
      </ul>
      <Select
        aria-label={`${label} lowest effort`}
        value={minEffort ?? ""}
        disabled={busy}
        onChange={(e) => void onMinEffort((e.target.value || null) as InferenceEffort | null)}
        className="max-md:w-full"
      >
        <option value="">Any effort</option>
        {EFFORTS.map((e) => (
          <option key={e} value={e}>
            {e} or higher
          </option>
        ))}
      </Select>
      <form
        className="flex items-center gap-2 max-md:w-full"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={40} placeholder="Add a family" aria-label={`Add a ${label} model family`} className="w-40 max-md:flex-1" />
        <Button type="submit" size="sm" disabled={!ok || busy} className="max-md:h-11">
          Add
        </Button>
      </form>
    </li>
  );
}
