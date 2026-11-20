import { CheckIcon, SlidersHorizontalIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useApi, useQuery } from "../../api/client";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Input } from "../../ui/atoms/Input";
import { Switch } from "../../ui/atoms/Switch";
import { Block } from "../../ui/molecules/Block";
import { CheckRow } from "../../ui/molecules/CheckRow";
import { useWrite } from "../../lib/hooks";
import { Fold } from "./Fold";
import { SectionTitle } from "./SectionTitle";

export function MySettings() {
  const api = useApi();
  const write = useWrite();
  const { data, error } = useQuery("my-settings", (a) => a.me.settings.get());
  const [vals, setVals] = useState<{ fiveHour: string; weekly: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [picks, setPicks] = useState<string[]>([]);
  const [maxCalls, setMaxCalls] = useState("");
  const [manual, setManual] = useState(false);
  // When the last change was saved: the header says "Saved" for a few seconds after each save.
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // Saves still running (the header says Saving… until all are done), and the number of the latest change: only the
  // save of the latest change may say Saved, so one that ends after a newer edit or save does not.
  const [saving, setSaving] = useState(0);
  const latest = useRef(0);
  const edited = () => {
    latest.current++;
    setSavedAt(null);
  };
  useEffect(() => {
    if (savedAt === null) return;
    const t = setTimeout(() => setSavedAt(null), 3000);
    return () => clearTimeout(t);
  }, [savedAt]);
  useEffect(() => {
    if (!data) return;
    setManual(data.manualOnly);
    setVals({ fiveHour: String(data.reserve.fiveHour), weekly: String(data.reserve.weekly) });
    setPicks(data.repos);
    setMaxCalls(data.maxCalls === null ? "" : String(data.maxCalls));
  }, [data]);
  if (!data || !vals) return error ? <ErrorLine error={error.message} className="mt-4" /> : null;
  /** Saves through the shared write state and marks the time it succeeded. */
  const saveRun = (key: string, f: () => Promise<unknown>) => {
    edited();
    const n = latest.current;
    setSaving((c) => c + 1);
    void write.run(key, f).then((ok) => {
      setSaving((c) => c - 1);
      if (ok && n === latest.current) setSavedAt(Date.now());
    });
  };
  const savePicks = (next: string[]) => {
    const was = picks;
    setPicks(next);
    saveRun("repos", async () => {
      try {
        setPicks((await api.me.settings.put({ repos: next })).repos);
      } catch (e) {
        setPicks(was);
        throw e;
      }
    });
  };
  const choices = new Set(data.repoChoices);
  // Picks that are no longer available (pipeline off, or no write permission) stay listed so they can be removed.
  const shown = [...new Set([...data.repoChoices, ...picks])].sort((x, y) => x.localeCompare(y, undefined, { sensitivity: "base" }));
  const valid = (v: string) => /^\d+$/.test(v) && Number(v) <= 90;
  const save = (next: { fiveHour: string; weekly: string }) => {
    if (!valid(next.fiveHour) || !valid(next.weekly)) {
      setProblem("Enter a whole number from 0 to 90.");
      return;
    }
    setProblem(null);
    const body = { reserve: { fiveHour: Number(next.fiveHour), weekly: Number(next.weekly) } };
    if (body.reserve.fiveHour === data.reserve.fiveHour && body.reserve.weekly === data.reserve.weekly) return;
    saveRun("settings", () => api.me.settings.put(body));
  };
  const validMax = (v: string) => v.trim() === "" || (/^\d+$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= 64);
  const saveMax = (v: string) => {
    if (!validMax(v)) {
      setProblem("Enter a whole number from 1 to 64, or leave it empty for no limit.");
      return;
    }
    setProblem(null);
    const next = v.trim() === "" ? null : Number(v);
    if (next === data.maxCalls) return;
    saveRun("max-calls", () => api.me.settings.put({ maxCalls: next }));
  };
  const saveManual = (on: boolean) => {
    setManual(on);
    saveRun("manual-only", async () => {
      try {
        setManual((await api.me.settings.put({ manualOnly: on })).manualOnly);
      } catch (e) {
        setManual(!on);
        throw e;
      }
    });
  };
  const field = (key: "fiveHour" | "weekly", short: string, label: string) => (
    <label className="flex items-center gap-1.5">
      <span className="whitespace-nowrap text-ink/60">{short}</span>
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        max={90}
        step={1}
        value={vals[key]}
        invalid={!valid(vals[key])}
        onChange={(e) => {
          const next = { ...vals, [key]: e.target.value };
          setVals(next);
          edited();
        }}
        onBlur={() => save(vals)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save(vals);
        }}
        aria-label={label}
        className="w-14 text-right"
      />
      <span className="text-ink/55">%</span>
    </label>
  );
  const item = "flex items-center gap-3 max-sm:justify-between";
  return (
    <Block
      dense
      className="mt-4"
      title={<SectionTitle icon={SlidersHorizontalIcon}>My settings</SectionTitle>}
      aside={
        <span role="status" aria-live="polite" className="flex items-center gap-1">
          {saving > 0 ? "Saving…" : savedAt !== null ? (
            <span className="flex items-center gap-1 font-medium text-ok">
              <CheckIcon aria-hidden weight="bold" /> Saved
            </span>
          ) : (
            "Changes save on their own"
          )}
        </span>
      }
    >
      <div className="flex flex-col gap-2 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-8">
        <div className={item}>
          <span className="whitespace-nowrap text-ink/80">Keep free</span>
          <span className="flex items-center gap-3">
            {field("fiveHour", "5h", "Keep free: 5-hour window")}
            {field("weekly", "week", "Keep free: weekly")}
          </span>
        </div>
        <label className={item}>
          <span className="text-ink/80">Max calls at once</span>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={64}
            step={1}
            placeholder="None"
            value={maxCalls}
            invalid={!validMax(maxCalls)}
            onChange={(e) => {
              setMaxCalls(e.target.value);
              edited();
            }}
            onBlur={() => saveMax(maxCalls)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveMax(maxCalls);
            }}
            aria-label="Max calls at once"
            className="w-20 text-right"
          />
        </label>
        <span className={item}>
          <span className="text-ink/80">Manual only</span>
          <Switch on={manual} onChange={saveManual} label="Manual only" busy={write.busy === "manual-only"} />
        </span>
      </div>
      <Fold className="mt-2" title="My repos" summary={picks.length ? `${picks.length} of ${shown.length} repos` : "All repos"}>
        <div role="group" aria-label="My repos" className="mt-1 rounded-md border border-line p-1 sm:max-w-3xl">
          <CheckRow checked={!picks.length} onChange={() => picks.length && savePicks([])} title="All repos" />
          <div className="sm:columns-2 sm:gap-x-1 lg:columns-3">
            {shown.map((r) => {
              const on = picks.includes(r);
              const ok = choices.has(r);
              return (
                <div key={r} className="break-inside-avoid">
                  <CheckRow
                    checked={on}
                    onChange={() => savePicks(on ? picks.filter((x) => x !== r) : [...picks, r].sort())}
                    title={
                      <span className={ok ? undefined : "line-through opacity-60"} title={ok ? undefined : "Pipeline off or no write permission"}>
                        {r}
                      </span>
                    }
                  />
                </div>
              );
            })}
          </div>
        </div>
      </Fold>
      <ErrorLine error={problem ?? write.error} className="mt-2" />
    </Block>
  );
}
