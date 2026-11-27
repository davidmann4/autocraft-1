// Admin pages, operator only. Each page hosts a view or controls under its heading, with a link back to the Admin index.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { CaretRightIcon, CheckCircleIcon, WarningCircleIcon, WarningIcon } from "@phosphor-icons/react";
import { t, tk } from "../../../../src/i18n/index.ts";
import type { FeatureModule, ViewProps } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";
import { useApi, useQuery } from "../../api/client";
import type { HealthProblem } from "../../api/types";
import { useWrite } from "../../lib/hooks";
import { Button } from "../../ui/atoms/Button";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { HostFrame, Page } from "../../ui/organisms/Page";
import { Block } from "../../ui/molecules/Block";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { TextInput } from "./parts";
import { OutsideLimits, PipelineSwitch, StageLimits } from "../pipeline/controls";
import { useEffect, useState } from "react";
import { cn } from "../../ui/cn";

const AccessView = lazyView(() => import("./accessViews"), "AccessView");
const AuditView = lazyView(() => import("./auditViews"), "AuditView");
const DiscordView = lazyView(() => import("./discordViews"), "DiscordView");
const GithubAppView = lazyView(() => import("./githubAppViews"), "GithubAppView");
const InferenceView = lazyView(() => import("../inference/views"), "InferenceView");
const NightlyView = lazyView(() => import("../nightly/views"), "NightlyView");
const StorageView = lazyView(() => import("./storageViews"), "StorageView");

interface AdminPage {
  id: string;
  label: string;
  view: (p: ViewProps) => ReactNode;
}

function Hosted({ title, children }: { title: string; children: ReactNode }) {
  return <HostFrame.Provider value={{ title, back: { to: "/admin", label: t("Admin") } }}>{children}</HostFrame.Provider>;
}

/** Problems of the instance with the control that fixes each; passing checks are not listed, an empty list says so. */
function HealthView(_: ViewProps) {
  const api = useApi();
  const write = useWrite();
  const { data, error } = useQuery("health", (a) => a.health(), { pollMs: 30_000 });
  const problems = (data?.problems ?? []).filter((p) => p.area !== "pipeline");
  const to = (p: HealthProblem) => (p.area === "breaker" || p.area === "limit" ? "/admin/limits" : p.to);
  return (
    <Page title={t("Health")}>
      <ErrorLine error={error?.message ?? write.error} className="mt-3" />
      <PipelineSwitch className="mt-4" />
      {data && (
        <section aria-label={t("Failing")} className="mt-5">
          <h2 className="mb-1 text-sm font-semibold text-ink/70">{problems.length ? t("Failing") : t("Nothing failing")}</h2>
          {problems.length > 0 && (
            <ul className={cn("divide-y divide-line rounded-lg border", problems.some((p) => p.tone === "bad") ? "border-bad/40" : "border-warn/40")}>
              {problems.map((p) => {
                const Ico = p.tone === "bad" ? WarningCircleIcon : WarningIcon;
                return (
                  <li key={p.id} className="flex flex-wrap items-center gap-2 px-3 py-3">
                    <Ico aria-hidden weight="fill" className={p.tone === "bad" ? "text-bad" : "text-warn"} />
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="break-words text-md [overflow-wrap:anywhere]">{p.text}</p>
                      {p.since && <TimeAgo iso={p.since} className="num text-xs text-ink/60" />}
                    </div>
                    {p.ackStep || p.ack ? (
                      <Button className="h-10" loading={write.busy === p.id} onClick={() => void write.run(p.id, () => (p.ackStep ? api.pipeline.ackDeadline(p.ackStep) : api.githubApp.ackForeignInstalls()))}>
                        {t("Acknowledge")}
                      </Button>
                    ) : p.fullPage ? (
                      <a href={`${p.to}?${new URLSearchParams({ return_to: window.location.pathname })}`} className="inline-flex h-10 items-center rounded-md border border-line-strong px-3 text-sm hover:bg-ink/[0.06]">
                        {t("Open")}
                      </a>
                    ) : (
                      <Link to={to(p)} className="inline-flex h-10 items-center rounded-md border border-line-strong px-3 text-sm hover:bg-ink/[0.06]">
                        {t("Open")}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {problems.length === 0 && (
            <p className="flex items-center gap-1.5 text-sm text-ink/70">
              <CheckCircleIcon aria-hidden weight="fill" className="text-ok" /> {t("All checks pass")}
            </p>
          )}
        </section>
      )}
    </Page>
  );
}

const BLOCKER_FIELDS = [
  { key: "outsidePurposeMin", label: "A change outside the PR's purpose of at least this many lines asks again" },
] as const;

function BlockerThresholds({ className }: { className?: string }) {
  const api = useApi();
  const { data } = useQuery("pipeline-state", (a) => a.pipeline.state());
  const write = useWrite();
  const b = data?.blockers;
  const [text, setText] = useState<Record<string, string>>({});
  useEffect(() => {
    if (b) setText({ outsidePurposeMin: String(b.outsidePurposeMin) });
  }, [b?.outsidePurposeMin]);
  if (!b) return null;
  const valid = BLOCKER_FIELDS.every((f) => /^[1-9]\d{0,5}$/.test((text[f.key] ?? "").trim()));
  const dirty = BLOCKER_FIELDS.some((f) => (text[f.key] ?? "").trim() !== String(b[f.key]));
  return (
    <div className={className}>
      <Block title={t("Blockers")}>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void write.run("blockers", () => api.pipeline.setBlockers(Object.fromEntries(BLOCKER_FIELDS.map((f) => [f.key, Number(text[f.key])]))));
          }}
        >
          {BLOCKER_FIELDS.map((f) => (
            <label key={f.key} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-md">
              <span className="min-w-0 flex-1 basis-56">{t(f.label)}</span>
              <TextInput inputMode="numeric" value={text[f.key] ?? ""} onChange={(e) => setText({ ...text, [f.key]: e.target.value })} className="w-24 text-ink" />
            </label>
          ))}
          <Button type="submit" size="sm" disabled={!dirty || !valid} loading={write.busy === "blockers"} className="w-fit max-md:h-11">
            {t("Save")}
          </Button>
          <ErrorLine error={write.error} />
        </form>
      </Block>
    </div>
  );
}

function SettingsView(_: ViewProps) {
  return (
    <Page title={t("Instance settings")}>
      <PipelineSwitch className="mt-4" />
      <BlockerThresholds className="mt-4" />
    </Page>
  );
}

function LimitsView(_: ViewProps) {
  return (
    <Page title={t("Limits")}>
      <OutsideLimits className="mt-4" />
      <div className="mt-4">
        <StageLimits />
      </div>
    </Page>
  );
}

const PAGES: AdminPage[] = [
  { id: "users", label: tk("Users and access"), view: (p) => <AccessView {...p} /> },
  { id: "health", label: tk("Health"), view: (p) => <HealthView {...p} /> },
  { id: "sweeps", label: tk("Sweeps"), view: (p) => <NightlyView {...p} /> },
  { id: "settings", label: tk("Instance settings"), view: (p) => <SettingsView {...p} /> },
  { id: "inference", label: tk("Inference"), view: (p) => <InferenceView {...p} /> },
  { id: "storage", label: tk("Storage"), view: (p) => <StorageView {...p} /> },
  { id: "github-app", label: tk("GitHub App"), view: (p) => <GithubAppView {...p} /> },
  { id: "discord", label: tk("Discord"), view: (p) => <DiscordView {...p} /> },
  { id: "limits", label: tk("Limits"), view: (p) => <LimitsView {...p} /> },
  { id: "audit", label: tk("Audit log"), view: (p) => <AuditView {...p} /> },
];

function AdminIndex(_: ViewProps) {
  const { data } = useQuery("health", (a) => a.health(), { pollMs: 30_000 });
  const failing = (data?.problems ?? []).filter((p) => p.area !== "pipeline").length;
  return (
    <Page title={t("Admin")}>
      <ul className="mt-4 divide-y divide-line rounded-lg border border-line">
        {PAGES.map((p) => (
          <li key={p.id}>
            <Link to={`/admin/${p.id}`} className="flex h-12 items-center justify-between rounded px-3 text-md hover:bg-ink/[0.04]">
              <span>
                {t(p.label)}
                {p.id === "health" && failing > 0 && <span className="ml-2 text-sm text-bad">{failing} {t("failing")}</span>}
              </span>
              <CaretRightIcon aria-hidden className="text-ink/60" />
            </Link>
          </li>
        ))}
      </ul>
    </Page>
  );
}

const routeFor = (p: AdminPage) => {
  const View = (props: ViewProps) => <Hosted title={t(p.label)}>{p.view(props)}</Hosted>;
  return { path: `admin/${p.id}`, permission: "operator" as const, view: { id: `admin-${p.id}`, title: p.label, panels: [{ id: "main", title: p.label, component: View, defaultSize: 100 }] } };
};

export const adminHubModule: FeatureModule = {
  id: "admin-hub",
  permission: "operator",
  routes: [
    { path: "admin", permission: "operator", view: { id: "admin", title: "Admin", panels: [{ id: "main", title: "Admin", component: AdminIndex, defaultSize: 100 }] } },
    ...PAGES.map(routeFor),
  ],
};
