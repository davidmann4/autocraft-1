// A repo's build features: one switch each, with a line saying what it does. The server lists only the features an enabled
// build environment can run (shownFeatures in src/build/features.ts).
import { useState } from "react";
import { useApi, useQuery } from "../../api/client";
import type { BuildFeatureName, RepoBuildFeature, ScreenshotConfigJson, ScreenshotSetups, TrackedRepo } from "../../api/types";
import { Badge } from "../../ui/atoms/Badge";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Switch } from "../../ui/atoms/Switch";
import { Textarea } from "../../ui/atoms/Textarea";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { Block } from "../../ui/molecules/Block";
import { ConfirmButton } from "../../ui/molecules/ConfirmButton";
import { useWrite } from "../../lib/hooks";
import type { Write } from "./repoParts";

const FEATURES: Record<BuildFeatureName, { name: string; line: string }> = {
  screenshots: { name: "Screenshots", line: "Renders the app for a PR and compares screenshots during Verify." },
  "push-tests": { name: "Tests before push", line: "Runs the repo's tests before AutoCraft pushes its own fix-up." },
  "batch-build": { name: "Build batches", line: "Builds a merge batch's branch before AutoCraft opens the batch PR." },
  nightly: { name: "Nightly checks", line: "Runs the repo's checks and benchmarks on main each night." },
  implement: { name: "Implement queued issues", line: "AutoCraft implements started issues in a workspace and opens the PR." },
  "pr-builds": { name: "Build pull requests", line: "Builds pull requests in a sandbox." },
  "scan-tests": { name: "Run scan tests", line: "Writes and runs a test for each security finding." },
};

/** The repo's screenshot commands as JSON; editing waits for the Screenshots switch. */
function ScreenshotSetup({ repo, enabled }: { repo: string; enabled: boolean }) {
  const api = useApi();
  const q = useQuery<ScreenshotSetups>("screenshot-setup", (a) => a.screenshotSetup.list());
  const write = useWrite();
  const [draft, setDraft] = useState<string | null>(null);
  const stored = q.data?.setups.find((x) => x.repo === repo);
  const storedText = stored ? JSON.stringify(stored.config, null, 2) : "";
  const text = draft ?? storedText;
  let parsed: ScreenshotConfigJson | null = null;
  let parseError: string | null = null;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text) as ScreenshotConfigJson;
    } catch (e) {
      parseError = (e as Error).message;
    }
  }
  const canEdit = !!q.data?.manageable.includes(repo);
  const off = !enabled || !canEdit;
  const save = () => parsed && void write.run("save", () => api.screenshotSetup.put(repo, parsed!)).then((ok) => ok && (setDraft(null), q.refetch()));
  const remove = () => void write.run("remove", () => api.screenshotSetup.remove(repo)).then((ok) => ok && (setDraft(null), q.refetch()));
  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Screenshot setup</span>
        {stored && <span className="text-xs text-ink/60">saved by {stored.updatedBy} <TimeAgo iso={stored.updatedAt} /></span>}
      </div>
      <Textarea aria-label={`Screenshot setup JSON for ${repo}`} rows={10} spellCheck={false} value={text} disabled={off} invalid={parseError !== null} onChange={(e) => setDraft(e.target.value)} className="font-mono text-xs" />
      <ErrorLine error={parseError ?? write.error ?? q.error?.message} />
      {canEdit && (
        <div className="flex gap-2">
          <Button size="sm" variant="primary" disabled={off || !parsed || text === storedText} loading={write.busy === "save"} onClick={save} className="max-md:h-11">Save</Button>
          {stored && <ConfirmButton label="Remove" confirmLabel="Confirm remove" loading={write.busy === "remove"} onConfirm={remove} className={off ? "pointer-events-none opacity-50" : undefined} />}
        </div>
      )}
    </div>
  );
}

function FeatureRow({ r, f, write }: { r: TrackedRepo; f: RepoBuildFeature; write: Write }) {
  const api = useApi();
  const { name, line } = FEATURES[f.feature];
  const patch = (on: boolean) => (cur: TrackedRepo): Partial<TrackedRepo> => ({ buildFeatures: cur.buildFeatures.map((x) => (x.feature === f.feature ? { ...x, on } : x)) });
  return (
    <li className="border-b border-line px-4 py-3 last:border-0">
      <div className="flex items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{name}</div>
          <div className="text-sm text-ink/60">{line}</div>
        </div>
        {r.canManage ? (
          <Switch on={f.on} label={name} onChange={(on) => void write.run(`feature:${f.feature}:${r.name}`, () => api.repoAdmin.setBuildFeature(r.name, f.feature, on), { repo: r.name, patch: patch(on) })} />
        ) : (
          <Badge tone={f.on ? "ok" : "neutral"}>{f.on ? "On" : "Off"}</Badge>
        )}
      </div>
      {f.feature === "screenshots" && <ScreenshotSetup repo={r.name} enabled={f.on} />}
    </li>
  );
}

export function BuildFeatures({ r, write }: { r: TrackedRepo; write: Write }) {
  if (!r.buildFeatures.length) return null;
  return (
    <Block className="mt-4" flush title="Build features">
      <ul>
        {r.buildFeatures.map((f) => (
          <FeatureRow key={f.feature} r={r} f={f} write={write} />
        ))}
      </ul>
    </Block>
  );
}
