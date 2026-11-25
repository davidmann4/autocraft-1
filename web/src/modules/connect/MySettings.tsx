import { CheckIcon, SlidersHorizontalIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useApi, useQuery } from "../../api/client";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Input } from "../../ui/atoms/Input";
import { Switch } from "../../ui/atoms/Switch";
import { Block } from "../../ui/molecules/Block";
import { CheckRow } from "../../ui/molecules/CheckRow";
import { RadioRow } from "../../ui/molecules/RadioRow";
import type { TaskItems } from "../../api/types";
import { TipLines, Tooltip } from "../../ui/atoms/Tooltip";
import { useWrite } from "../../lib/hooks";
import { Fold } from "./Fold";
import { t } from "../../../../src/i18n/index.ts";
import { SectionTitle } from "./SectionTitle";

/** A model id as people say it: opus → Opus. */
const modelName = (m: string) => m.charAt(0).toUpperCase() + m.slice(1);

/** The item choices of My tasks: fast-tracked items are those added with Queue items, the queue command or the fast-track list. */
const ITEMS_LABEL: Record<TaskItems, string> = { all: "All items", fast: "Fast-tracked", mine: "Fast-tracked by me" };

/**
 * Saves of one setting run one after another, so the server ends with the latest selection. `confirmed` is the server's last
 * answer; only the latest save sets the control, from its answer or, when it fails, back to `confirmed`.
 */
type ListSaves<T = string[]> = { chain: Promise<unknown>; n: number; confirmed: T };
const listSaves = <T = string[],>(confirmed: T): ListSaves<T> => ({ chain: Promise.resolve(), n: 0, confirmed });

/** `runner`: the Runner page's layout of the same settings (what the runner takes, Takes, Limits, Interactive slots, Visibility). */
export function MySettings({ runner = false }: { runner?: boolean }) {
  const api = useApi();
  const write = useWrite({ latestOnly: true });
  const { data, error } = useQuery("my-settings", (a) => a.me.settings.get());
  const [vals, setVals] = useState<{ fiveHour: string; weekly: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [picks, setPicks] = useState<string[]>([]);
  const [tasks, setTasks] = useState<string[]>([]);
  const [maxCalls, setMaxCalls] = useState("");
  const [slots, setSlots] = useState("");
  const [manual, setManual] = useState(false);
  const [priv, setPriv] = useState(false);
  const [taskItems, setTaskItems] = useState<TaskItems>("all");
  // When the last change was saved: the header says "Saved" for a few seconds after each save.
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // Saves still running (the header says Saving… until all are done), and the number of the latest change: only the
  // save of the latest change may say Saved, so one that ends after a newer edit or save does not.
  const [saving, setSaving] = useState(0);
  const latest = useRef(0);
  const repoSaves = useRef(listSaves<string[]>([]));
  const taskSaves = useRef(listSaves<string[]>([]));
  const itemSaves = useRef(listSaves<TaskItems>("all"));
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
    setPriv(data.runnerPrivate);
    setTaskItems(data.taskItems);
    itemSaves.current.confirmed = data.taskItems;
    setVals({ fiveHour: String(data.reserve.fiveHour), weekly: String(data.reserve.weekly) });
    setPicks(data.repos);
    repoSaves.current.confirmed = data.repos;
    setTasks(data.tasks);
    taskSaves.current.confirmed = data.tasks;
    setMaxCalls(data.maxCalls === null ? "" : String(data.maxCalls));
    setSlots(String(data.interactiveSlots));
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
  const saveList = <T,>(key: string, s: ListSaves<T>, next: T, set: (v: T) => void, put: () => Promise<T>) => {
    const n = ++s.n;
    set(next);
    saveRun(key, () => {
      const run = s.chain.then(async () => {
        try {
          s.confirmed = await put();
        } finally {
          if (n === s.n) set(s.confirmed);
        }
      });
      s.chain = run.catch(() => undefined);
      return run;
    });
  };
  const savePicks = (next: string[]) => saveList("repos", repoSaves.current, next, setPicks, async () => (await api.me.settings.put({ repos: next })).repos);
  const saveTasks = (next: string[]) => saveList("tasks", taskSaves.current, next, setTasks, async () => (await api.me.settings.put({ tasks: next })).tasks);
  const allTasks = data.taskChoices.map((t) => t.id);
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
  const validSlots = (v: string) => /^\d$/.test(v.trim()) && Number(v) <= 4;
  const saveSlots = (v: string) => {
    if (!validSlots(v)) {
      setProblem("Enter a whole number from 0 to 4.");
      return;
    }
    setProblem(null);
    if (Number(v) === data.interactiveSlots) return;
    saveRun("interactive-slots", () => api.me.settings.put({ interactiveSlots: Number(v) }));
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
  const savePrivate = (on: boolean) => {
    setPriv(on);
    saveRun("runner-private", async () => {
      try {
        setPriv((await api.me.settings.put({ runnerPrivate: on })).runnerPrivate);
      } catch (e) {
        setPriv(!on);
        throw e;
      }
    });
  };
  const saveTaskItems = (v: TaskItems) => saveList("task-items", itemSaves.current, v, setTaskItems, async () => (await api.me.settings.put({ taskItems: v })).taskItems);
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
  if (runner) {
    const sec = "flex flex-col gap-2 border-t border-line pt-4";
    const h = "text-md font-semibold";
    const num = (label: string, value: string, set: (v: string) => void, save: (v: string) => void, valid: boolean, min: number, max: number, ph?: string) => (
      <label className="flex min-h-11 items-center justify-between gap-3 text-md">
        {label}
        <Input type="number" inputMode="numeric" min={min} max={max} step={1} placeholder={ph} value={value} invalid={!valid} aria-label={label} className="w-20 text-right"
          onChange={(e) => { set(e.target.value); edited(); }} onBlur={() => save(value)} onKeyDown={(e) => { if (e.key === "Enter") save(value); }} />
      </label>
    );
    const takes = (repo: string) => !manual && (!picks.length || picks.includes(repo));
    return (
      <div className="mt-4 flex flex-col gap-4">
        <section aria-label={t("What your runner takes")} className={sec}>
          <h2 className={h}>{t("What your runner takes")}</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {data.repoChoices.map((repo) => (
              <li key={repo}>
                <span className="code">{repo}</span>: {takes(repo) ? t("all work you may run") : t("only what you start")}
              </li>
            ))}
            <li className="text-ink/70">{t("Other repos: only what you start")}</li>
          </ul>
        </section>
        <section aria-label={t("Takes")} className={sec}>
          <h2 className={h}>{t("Takes")}</h2>
          <div role="radiogroup" aria-label={t("Takes")}>
            <RadioRow selected={manual} onSelect={() => !manual && saveManual(true)} title={t("Only what I start")} />
            <RadioRow selected={!manual} onSelect={() => manual && saveManual(false)} title={t("Anything I may run")}>
              <Fold title={t("My repos")} summary={picks.length ? `${picks.length} / ${shown.length}` : t("All my repos")}>
              <div role="group" aria-label={t("My repos")} className="mt-1 rounded-md border border-line p-1">
                <CheckRow checked={!picks.length} onChange={() => picks.length && savePicks([])} title={t("All my repos")} />
                {shown.map((r) => {
                  const ok = choices.has(r);
                  return (
                    <CheckRow key={r} checked={picks.includes(r)} onChange={() => savePicks(picks.includes(r) ? picks.filter((x) => x !== r) : [...picks, r].sort())}
                      title={<span className={ok ? undefined : "line-through opacity-60"} title={ok ? undefined : t("Pipeline off or no write permission")}>{r}</span>} />
                  );
                })}
              </div>
              </Fold>
              <Fold title={t("Task kinds")} summary={tasks.length === allTasks.length ? t("All task kinds") : `${tasks.length} / ${allTasks.length}`}>
              <div role="group" aria-label={t("Task kinds")} className="mt-1 rounded-md border border-line p-1">
                <CheckRow checked={tasks.length === allTasks.length} onChange={(on) => saveTasks(on ? allTasks : [])} title={t("All task kinds")} />
                {data.taskChoices.map((k) => (
                  <CheckRow key={k.id} checked={tasks.includes(k.id)} onChange={() => saveTasks(tasks.includes(k.id) ? tasks.filter((x) => x !== k.id) : allTasks.filter((x) => x === k.id || tasks.includes(x)))} title={k.title} description={k.about} />
                ))}
              </div>
              </Fold>
            </RadioRow>
          </div>
        </section>
        <section aria-label={t("Limits")} className={sec}>
          <h2 className={h}>{t("Limits")}</h2>
          {num(t("Calls at once"), maxCalls, setMaxCalls, saveMax, validMax(maxCalls), 1, 64, t("None"))}
          {num(t("Keep of 5-hour quota (%)"), vals.fiveHour, (v) => setVals({ ...vals, fiveHour: v }), (v) => save({ ...vals, fiveHour: v }), valid(vals.fiveHour), 0, 90)}
          {num(t("Keep of weekly quota (%)"), vals.weekly, (v) => setVals({ ...vals, weekly: v }), (v) => save({ ...vals, weekly: v }), valid(vals.weekly), 0, 90)}
        </section>
        <section aria-label={t("Interactive slots")} className={sec}>
          <h2 className={h}>{t("Interactive slots")}</h2>
          {num(t("Discord replies at once"), slots, setSlots, saveSlots, validSlots(slots), 0, 4)}
          <p className="text-sm text-ink/70">{t("Separate from calls at once. Pipeline work never uses them.")}</p>
        </section>
        <section aria-label={t("Visibility")} className={sec}>
          <h2 className={h}>{t("Visibility")}</h2>
          <div className="flex min-h-11 items-center justify-between gap-3 text-md">
            <span>{t("Show my runner on the shared runner list")}</span>
            <Switch on={!priv} onChange={(on) => savePrivate(!on)} label={t("Show my runner on the shared runner list")} busy={write.busy === "runner-private"} />
          </div>
        </section>
        <ErrorLine error={problem ?? write.error} />
      </div>
    );
  }
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
        <label className={item}>
          <span className="text-ink/80">Interactive slots</span>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={4}
            step={1}
            value={slots}
            invalid={!validSlots(slots)}
            onChange={(e) => {
              setSlots(e.target.value);
              edited();
            }}
            onBlur={() => saveSlots(slots)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveSlots(slots);
            }}
            aria-label="Interactive slots"
            className="w-20 text-right"
          />
        </label>
        <span className={item}>
          <span className="text-ink/80">Manual only</span>
          <Switch on={manual} onChange={saveManual} label="Manual only" busy={write.busy === "manual-only"} />
        </span>
        <span className={item}>
          <span className="text-ink/80">Private on the Live board</span>
          <Switch on={priv} onChange={savePrivate} label="Private on the Live board" busy={write.busy === "runner-private"} />
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
      <Fold className="mt-1" title="My tasks" summary={`${tasks.length === allTasks.length ? "All tasks" : `${tasks.length} of ${allTasks.length} tasks`}${taskItems === "all" ? "" : `, ${ITEMS_LABEL[taskItems].toLowerCase()}`}`}>
        <div className="mt-1 text-sm text-ink/80">Run my tasks on</div>
        <div role="radiogroup" aria-label="Run my tasks on" className="mt-1 rounded-md border border-line p-1 sm:max-w-md">
          {(["all", "fast", "mine"] as const).map((v) => (
            <RadioRow key={v} selected={taskItems === v} onSelect={() => taskItems !== v && saveTaskItems(v)} title={ITEMS_LABEL[v]} />
          ))}
        </div>
        <div className="mt-2 text-sm text-ink/80">Tasks</div>
        <div role="group" aria-label="Tasks" className="mt-1 rounded-md border border-line p-1 sm:max-w-md">
          <CheckRow checked={tasks.length === allTasks.length} onChange={(on) => saveTasks(on ? allTasks : [])} title="All tasks" />
          <div>
            {data.taskChoices.map((t) => {
              const on = tasks.includes(t.id);
              return (
                <Tooltip key={t.id} side="right" align="start" title={t.title} content={<TipLines lines={[t.about, t.models.length > 0 && `Models: ${t.models.map(modelName).join(", ")}`]} />}>
                  <div>
                    <CheckRow
                      checked={on}
                      onChange={() => saveTasks(on ? tasks.filter((x) => x !== t.id) : allTasks.filter((x) => x === t.id || tasks.includes(x)))}
                      title={t.title}
                      description={`${t.about}${t.models.length ? ` Models: ${t.models.map(modelName).join(", ")}.` : ""}`}
                    />
                  </div>
                </Tooltip>
              );
            })}
          </div>
        </div>
      </Fold>
      <ErrorLine error={problem ?? write.error} className="mt-2" />
    </Block>
  );
}
