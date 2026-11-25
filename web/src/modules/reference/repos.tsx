// Repos: each repository with its counts and the Automatic switch; a repository page with paused steps and, folded, its settings.
import { useState } from "react";
import { Link } from "react-router-dom";
import { t } from "../../../../src/i18n/index.ts";
import { useApi, useQuery } from "../../api/client";
import type { MaintainRepo, TrackedRepo } from "../../api/types";
import type { ViewProps } from "../../registry/types";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Switch } from "../../ui/atoms/Switch";
import { useUser } from "../../shell/UserContext";
import { RepoSettings } from "../admin/repoDetail";
import { useRepoWrite } from "../admin/repoParts";
import { Fold, List, Loading, RefPage } from "./parts";

const counts = (r: MaintainRepo) => t("{open} open · {started} started · {waiting} waiting · {merged} merged this week", { open: r.open, started: r.started, waiting: r.waiting, merged: r.mergedWeek });

/** Automatic on a repository: the workflow control where the repo has the new workflow, the classic pipeline switch where it has not. */
function useRepoActions(refetch: () => void) {
  const api = useApi();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, f: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      const r = (await f()) as { ok?: boolean; line?: string } | null;
      if (r && r.ok === false) setError(r.line ?? "");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      refetch();
    }
  };
  return {
    error, busy,
    setAutomatic: (r: MaintainRepo, on: boolean) => run(`auto:${r.name}`, () => (r.workflow === "new" ? api.maintain.control({ control: "set-automatic", repo: r.name, on }) : api.repoAdmin.setPipeline(r.name, on))),
    resume: (r: MaintainRepo, key: string) => run(`resume:${key}`, () => (r.workflow === "new" ? api.maintain.control({ control: "resume-breaker", key }) : api.pipeline.resumeTrip(key))),
  };
}

function AutomaticSwitch({ r, act }: { r: MaintainRepo; act: ReturnType<typeof useRepoActions> }) {
  if (!r.canRun) return <span className="text-sm text-ink/80">{t("Automatic")}: {r.automatic ? t("on") : t("off")}</span>;
  return (
    <label className="flex items-center gap-2 text-sm">
      <span>{t("Automatic")}</span>
      <Switch on={r.automatic} busy={act.busy === `auto:${r.name}`} onChange={(on) => void act.setAutomatic(r, on)} label={t("Automatic handling on {repo}", { repo: r.name })} />
    </label>
  );
}

function ReposList() {
  const q = useQuery("maintain-repos", (a) => a.maintain.repos());
  const act = useRepoActions(q.refetch);
  return (
    <RefPage title={t("Repos")}>
      <ErrorLine error={act.error ?? q.error?.message} />
      {!q.data ? (
        <Loading />
      ) : (
        <List>
          {q.data.map((r) => (
            <li key={r.name} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <Link to={`/repos/${r.name}`} className="code rounded text-md font-semibold hover:underline">{r.name}</Link>
                <p className="text-sm text-ink/70">{counts(r)}</p>
                {r.trips.length > 0 && <p className="text-sm text-warn">{t("{n} paused", { n: r.trips.length })}</p>}
              </div>
              <AutomaticSwitch r={r} act={act} />
            </li>
          ))}
        </List>
      )}
    </RefPage>
  );
}

/** The classic settings of a repo (GitHub writes, build features, checks), for whoever runs it. */
function Settings({ name }: { name: string }) {
  const { data } = useQuery("repo-admin", (a) => a.repoAdmin.list());
  const write = useRepoWrite();
  const r: TrackedRepo | undefined = data?.find((x) => x.name === name);
  if (!r?.tracked) return null;
  return (
    <Fold title={t("Settings")} className="border-t border-line pt-3">
      <div className="pb-2">
        <ErrorLine error={write.error} />
        <RepoSettings r={r} write={write} staff />
      </div>
    </Fold>
  );
}

function RepoPage({ name }: { name: string }) {
  const user = useUser();
  const q = useQuery("maintain-repos", (a) => a.maintain.repos());
  const act = useRepoActions(q.refetch);
  const r = q.data?.find((x) => x.name === name);
  return (
    <RefPage title={<span className="code">{name}</span>} back={{ to: "/repos", label: t("Repos") }}>
      <ErrorLine error={act.error ?? q.error?.message} />
      {!q.data ? (
        <Loading />
      ) : !r ? (
        <p className="text-sm">{t("No such repo.")}</p>
      ) : (
        <>
          <p className="text-sm text-ink/80">
            {counts(r)} · <Link to={`/items?repo=${name}&show=all`} className="rounded text-accent-ink underline underline-offset-2">{t("Items")}</Link>
          </p>
          <div className="flex min-h-11 items-center justify-between gap-3 text-md">
            <span>{t("Automatic handling")}</span>
            {r.canRun ? <AutomaticSwitch r={r} act={act} /> : <span>{r.automatic ? t("On") : t("Off")}</span>}
          </div>
          {r.trips.length > 0 && (
            <section aria-label={t("Paused")} className="flex flex-col gap-2 border-t border-line pt-4">
              <h2 className="text-md font-semibold">{t("Paused")}</h2>
              {r.trips.map((p) => (
                <div key={p.key} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1">{p.text}</span>
                  {p.canResume && (
                    <Button className="h-11" loading={act.busy === `resume:${p.key}`} onClick={() => void act.resume(r, p.key)}>{t("Resume")}</Button>
                  )}
                </div>
              ))}
            </section>
          )}
          <Fold title={t("Unattended fixes")} className="border-t border-line pt-3">
            <p className="py-2 text-sm">
              {t("Small and medium bug fixes from listed authors run without a maintainer. The rule and the author lists are on")}{" "}
              <Link to="/contributors" className="rounded text-accent-ink underline underline-offset-2">{t("Contributors")}</Link>.
            </p>
          </Fold>
          {user.role !== "viewer" && r.canRun && <Settings name={name} />}
        </>
      )}
    </RefPage>
  );
}

export function ReposView({ params }: ViewProps) {
  return params.name ? <RepoPage name={params.name} /> : <ReposList />;
}
