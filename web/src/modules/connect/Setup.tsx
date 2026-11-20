import { ListNumbersIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { cn } from "../../ui/cn";
import { CodeBlock } from "../../ui/molecules/CodeBlock";
import { Segmented } from "../../ui/molecules/Segmented";
import { Block } from "../../ui/molecules/Block";
import { SectionTitle } from "./SectionTitle";

type Alt = { key: string; label: string; text: string };
type Step = { label: string; alts: Alt[] };

const HARNESS = "Harness, if setup did not pick one";

/** A Task Runner's setup, one command per step (or one per alternative); `origin` is this dashboard. */
const steps = (origin: string): Step[] => [
  // `setup` offers to install what the machine lacks, asking first, then logs in to this dashboard.
  { label: "Install and set up, then approve the code here", alts: [{ key: "", label: "", text: `mkdir -p ~/.local/bin && curl -fsSL ${origin}/worker/autocraft.mjs -o ~/.local/bin/autocraft && chmod +x ~/.local/bin/autocraft && ~/.local/bin/autocraft setup ${origin}` }] },
  {
    label: HARNESS,
    alts: [
      { key: "linux", label: "Linux login", text: "autocraft harness claude --config-dir" },
      { key: "mac", label: "macOS login", text: "autocraft harness claude --keychain" },
      { key: "token", label: "Token on stdin", text: "claude setup-token\nautocraft harness claude" },
    ],
  },
  { label: "Check the setup", alts: [{ key: "", label: "", text: "autocraft doctor" }] },
  {
    label: "Run",
    alts: [
      { key: "terminal", label: "In a terminal", text: "autocraft work" },
      { key: "once", label: "One call", text: "autocraft run" },
      { key: "service", label: "Always on", text: "autocraft service install" },
    ],
  },
];

const onMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);

/** The setup commands for a new Task Runner, numbered; steps with alternatives pick one with a segmented control. */
export function RunnerSetup({ className }: { className?: string }) {
  const [pick, setPick] = useState<Record<string, string>>({ [HARNESS]: onMac ? "mac" : "linux", Run: "terminal" });
  return (
    <ol className={cn("space-y-2.5 px-3 py-3", className)}>
      {steps(location.origin).map((s, i) => {
        const alt = s.alts.find((a) => a.key === pick[s.label]) ?? s.alts[0];
        return (
          <li key={s.label} className="flex gap-2.5">
            <span className="num mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-ink/[0.07] text-2xs font-semibold text-ink/70">{i + 1}</span>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-sm font-medium">{s.label}</span>
                {s.alts.length > 1 && <Segmented label={s.label} value={alt.key} options={s.alts.map((a) => ({ value: a.key, label: a.label }))} onChange={(v) => setPick({ ...pick, [s.label]: v })} />}
              </div>
              <CodeBlock compact title={s.label} text={alt.text} />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** The setup guide as a block of its own: its own view at /connect/setup, and the whole page while the user has no Task Runner. */
export function RunnerGuide() {
  return (
    <Block dense flush className="mt-4" title={<SectionTitle icon={ListNumbersIcon}>Set up a Task Runner</SectionTitle>}>
      <RunnerSetup />
    </Block>
  );
}
