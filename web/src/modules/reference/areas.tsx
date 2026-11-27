// A repo's areas on its project page: the list with open counts, the model's open proposals, the version history,
// and, for whoever runs the repo, the edits and the model steps. Every change goes through the areas API.
import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowsClockwiseIcon, ArrowsMergeIcon, LightbulbIcon, ListBulletsIcon, PencilSimpleIcon, PlusIcon, TextAaIcon, TrashIcon } from "@phosphor-icons/react";
import { useApi, useQuery } from "../../api/client";
import type { AreaDef, AreaEditBody, AreaProposal, AreaStep, RepoAreas } from "../../api/types";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Input } from "../../ui/atoms/Input";
import { Select } from "../../ui/atoms/Select";
import { Textarea } from "../../ui/atoms/Textarea";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { CheckRow } from "../../ui/molecules/CheckRow";
import { Dialog } from "../../ui/molecules/Dialog";
import { DisclosurePanel } from "../../ui/molecules/DisclosurePanel";
import { OverflowMenu } from "../../ui/molecules/OverflowMenu";
import { Section } from "../../ui/molecules/Section";
import { num } from "../../lib/format";
import { useWrite } from "../../lib/hooks";
import { canRun } from "../../registry/permissions";
import { useUser } from "../../shell/UserContext";

const NAME_MAX = 60;
const DESCRIPTION_MAX = 240;

const itemsOf = (repo: string, extra: Record<string, string>) => `/items?${new URLSearchParams({ repo, ...extra })}`;

type Edit = { op: "add" } | { op: "rename" | "describe" | "merge" | "remove"; area: AreaDef };

const STEP_QUEUED: Record<AreaStep, string> = {
  propose: "Queued: a new area list from the model",
  suggest: "Queued: new areas suggested from the items without one",
  rescan: "Queued: a re-scan of the items without an area",
};

/** The Areas part of a single repo's project page. */
export function RepoAreasSection({ repo }: { repo: string }) {
  const api = useApi();
  const user = useUser();
  const runs = canRun(user, repo);
  const { data, error } = useQuery(`areas:${repo}`, (a) => a.areas.get(repo));
  const write = useWrite();
  const [edit, setEdit] = useState<Edit | null>(null);
  const [started, setStarted] = useState<{ step: AreaStep; job: number } | null>(null);
  const shown = data?.repo === repo ? data : undefined;

  const step = (s: AreaStep) => void write.run(`run:${s}`, async () => {
    setStarted(null);
    const { jobId } = await api.areas.run(repo, s);
    setStarted({ step: s, job: jobId });
  });

  return (
    <Section title="Areas" count={shown?.areas.length} to={itemsOf(repo, { group: "area" })} linkLabel="Items by area">
      {!shown ? (
        error ? <ErrorLine error={`The areas could not be read: ${error.message}`} className="border-t border-line py-3" /> : <p role="status" className="border-t border-line py-3 text-sm text-ink/50">Loading areas…</p>
      ) : (
        <div className="flex flex-col gap-3">
          {shown.proposals.map((p) => <ProposalCard key={p.id} proposal={p} runs={runs} />)}
          <AreaList repo={repo} data={shown} runs={runs} onEdit={setEdit} />
          {runs && (
            <div className="flex flex-wrap items-center gap-2">
              {shown.version === null ? (
                <Button variant="primary" icon={LightbulbIcon} loading={write.busy === "run:propose"} onClick={() => step("propose")} className="max-md:h-11">Propose areas</Button>
              ) : (
                <>
                  <Button icon={PlusIcon} onClick={() => setEdit({ op: "add" })} className="max-md:h-11">Add area</Button>
                  <Button icon={ArrowsClockwiseIcon} loading={write.busy === "run:rescan"} disabled={!shown.unassigned} onClick={() => step("rescan")} className="max-md:h-11">Re-scan items without an area</Button>
                  <Button variant="ghost" icon={LightbulbIcon} loading={write.busy === "run:suggest"} disabled={!shown.unassigned} onClick={() => step("suggest")} className="max-md:h-11">Suggest areas</Button>
                  <Button variant="ghost" icon={ListBulletsIcon} loading={write.busy === "run:propose"} onClick={() => step("propose")} className="max-md:h-11">Propose a new list</Button>
                </>
              )}
            </div>
          )}
          <p role="status" className="text-xs text-ink/65 empty:hidden">{started ? `${STEP_QUEUED[started.step]} (job ${started.job}).` : ""}</p>
          <ErrorLine error={write.error} />
          {shown.versions.length > 0 && <History data={shown} />}
        </div>
      )}
      {edit && shown && <EditDialog repo={repo} edit={edit} areas={shown.areas} onClose={() => setEdit(null)} />}
    </Section>
  );
}

function AreaList({ repo, data, runs, onEdit }: { repo: string; data: RepoAreas; runs: boolean; onEdit: (e: Edit) => void }) {
  const open = new Map(data.counts.map((c) => [c.area, c.open]));
  if (!data.areas.length) return <p className="border-t border-line py-3 text-sm text-ink/55">No area list yet.</p>;
  return (
    <ul aria-label="Areas" className="m-0 list-none p-0">
      {data.areas.map((a) => (
        <AreaRow key={a.name} name={a.name} description={a.description} count={open.get(a.name) ?? 0} to={itemsOf(repo, { area: a.name })}
          menu={runs ? (
            <OverflowMenu label={`Actions for ${a.name}`} actions={[
              { key: "rename", label: "Rename", icon: TextAaIcon, onSelect: () => onEdit({ op: "rename", area: a }) },
              { key: "describe", label: "Edit description", icon: PencilSimpleIcon, onSelect: () => onEdit({ op: "describe", area: a }) },
              ...(data.areas.length > 1 ? [{ key: "merge", label: "Merge into…", icon: ArrowsMergeIcon, onSelect: () => onEdit({ op: "merge", area: a }) }] : []),
              { key: "remove", label: "Remove", icon: TrashIcon, tone: "bad" as const, onSelect: () => onEdit({ op: "remove", area: a }) },
            ]} />
          ) : undefined} />
      ))}
      <AreaRow name="No area" count={data.unassigned} to={itemsOf(repo, { area: "none" })} muted gutter={runs} />
    </ul>
  );
}

/** `gutter`: the row has no menu of its own but lines up with rows that do. */
function AreaRow({ name, description, count, to, menu, muted, gutter }: { name: string; description?: string; count: number; to: string; menu?: ReactNode; muted?: boolean; gutter?: boolean }) {
  return (
    <li className="flex items-center gap-3 border-t border-line py-2.5 max-md:py-3">
      <div className="min-w-0 flex-1">
        <div className={muted ? "text-sm text-ink/70" : "text-sm font-medium"}>{name}</div>
        {description && <div className="mt-0.5 break-words text-xs text-ink/60">{description}</div>}
      </div>
      <Link to={to} className="num inline-flex shrink-0 items-center whitespace-nowrap text-xs text-accent-ink hover:underline max-md:min-h-11">
        {num(count)} open<span className="sr-only"> items in {name}</span>
      </Link>
      {menu ?? (gutter ? <span className="w-7 shrink-0 max-md:w-11" aria-hidden /> : null)}
    </li>
  );
}

/** A model's open proposal: a whole list to use, or new areas to tick and add. */
function ProposalCard({ proposal: p, runs }: { proposal: AreaProposal; runs: boolean }) {
  const api = useApi();
  const write = useWrite();
  const open = p.areas.filter((a) => a.state === "open");
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(open.map((a) => a.name)));
  const suggest = p.kind === "suggest";
  const title = suggest ? "Suggested areas" : "Proposed area list";
  const accept = () => void write.run("accept", () => suggest
    ? api.areas.accept(p.id, { accept: open.filter((a) => ticked.has(a.name)).map((a) => a.name), ignore: open.filter((a) => !ticked.has(a.name)).map((a) => a.name) })
    : api.areas.accept(p.id));
  return (
    <section aria-label={title} className="rounded-md border border-line bg-raised p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="text-xs text-ink/55">{num(open.length)} {open.length === 1 ? "area" : "areas"}{p.createdBy ? ` · started by ${p.createdBy}` : ""} · <TimeAgo iso={p.createdAt} /></span>
      </div>
      {suggest && runs ? (
        <div className="mt-2 flex flex-col">
          {open.map((a) => (
            <CheckRow key={a.name} checked={ticked.has(a.name)} title={<span className="font-medium">{a.name}</span>}
              onChange={(on) => setTicked((s) => { const n = new Set(s); if (on) n.add(a.name); else n.delete(a.name); return n; })}>
              <span className="text-xs text-ink/60">{a.description}</span>
            </CheckRow>
          ))}
        </div>
      ) : (
        <ul className="mt-2 m-0 list-none p-0">
          {open.map((a) => (
            <li key={a.name} className="border-t border-line py-2 first:border-0">
              <div className="text-sm font-medium">{a.name}</div>
              <div className="mt-0.5 break-words text-xs text-ink/60">{a.description}</div>
            </li>
          ))}
        </ul>
      )}
      {runs && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" loading={write.busy === "accept"} disabled={suggest && !ticked.size} onClick={accept} className="max-md:h-11">
            {suggest ? `Add ${num(ticked.size)} ${ticked.size === 1 ? "area" : "areas"}` : "Use this list"}
          </Button>
          <Button variant="ghost" loading={write.busy === "dismiss"} onClick={() => void write.run("dismiss", () => api.areas.dismiss(p.id))} className="max-md:h-11">Dismiss</Button>
        </div>
      )}
      <ErrorLine error={write.error} className="mt-2" />
    </section>
  );
}

function History({ data }: { data: RepoAreas }) {
  return (
    <DisclosurePanel title="History" summary={<>Version {data.version}{data.savedBy ? `, saved by ${data.savedBy}` : ""}{data.savedAt ? <> · <TimeAgo iso={data.savedAt} /></> : null}</>}>
      <ol className="m-0 list-none p-0">
        {data.versions.map((v) => (
          <li key={v.version} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-t border-line px-4 py-2 text-xs first:border-0">
            <span className="num w-8 shrink-0 text-ink/55">v{v.version}</span>
            <span className="min-w-0 flex-1 break-words text-ink/80">{v.note ?? "saved"}</span>
            <span className="text-ink/55">{v.by ?? "AutoCraft"} · <TimeAgo iso={v.at} /></span>
          </li>
        ))}
      </ol>
    </DisclosurePanel>
  );
}

const TITLE: Record<Edit["op"], (name: string) => string> = {
  add: () => "Add area",
  rename: (n) => `Rename ${n}`,
  describe: (n) => `Edit the description of ${n}`,
  merge: (n) => `Merge ${n} into another area`,
  remove: (n) => `Remove ${n}`,
};

/** One edit of the list; each saved edit is a new version. */
function EditDialog({ repo, edit, areas, onClose }: { repo: string; edit: Edit; areas: AreaDef[]; onClose: () => void }) {
  const api = useApi();
  const write = useWrite();
  const area = edit.op === "add" ? undefined : edit.area;
  const [name, setName] = useState(area?.name ?? "");
  const [description, setDescription] = useState(area?.description ?? "");
  const others = areas.filter((a) => a.name !== area?.name);
  const [into, setInto] = useState(others[0]?.name ?? "");
  const body = (): AreaEditBody => {
    switch (edit.op) {
      case "add": return { op: "add", name: name.trim(), description: description.trim() };
      case "rename": return { op: "rename", from: edit.area.name, to: name.trim() };
      case "describe": return { op: "describe", name: edit.area.name, description: description.trim() };
      case "merge": return { op: "merge", from: edit.area.name, into };
      case "remove": return { op: "remove", name: edit.area.name };
    }
  };
  const ready = edit.op === "add" ? !!name.trim() && !!description.trim() : edit.op === "rename" ? !!name.trim() && name.trim() !== area?.name : edit.op === "describe" ? !!description.trim() : edit.op === "merge" ? !!into : true;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    void write.run("save", () => api.areas.edit(repo, body())).then((ok) => { if (ok) onClose(); });
  };
  const label = { add: "Add", rename: "Rename", describe: "Save", merge: "Merge", remove: "Remove" }[edit.op];
  return (
    <Dialog open onClose={onClose} title={TITLE[edit.op](area?.name ?? "")}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        {(edit.op === "add" || edit.op === "rename") && (
          <label className="flex flex-col gap-1 text-xs text-ink/60">
            Name
            <Input autoFocus value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} className="w-full" />
          </label>
        )}
        {(edit.op === "add" || edit.op === "describe") && (
          <label className="flex flex-col gap-1 text-xs text-ink/60">
            Description
            <Textarea autoFocus={edit.op === "describe"} value={description} maxLength={DESCRIPTION_MAX} rows={3} onChange={(e) => setDescription(e.target.value)} className="w-full max-md:text-[16px]" />
          </label>
        )}
        {edit.op === "merge" && (
          <label className="flex flex-col gap-1 text-xs text-ink/60">
            Merge into
            <Select autoFocus value={into} onChange={(e) => setInto(e.target.value)} className="w-full">
              {others.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
            </Select>
          </label>
        )}
        {edit.op === "remove" && <p className="text-sm text-ink/80">Its items are left without an area and asked again against the rest of the list.</p>}
        <ErrorLine error={write.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} className="max-md:h-11">Cancel</Button>
          <Button type="submit" variant={edit.op === "remove" ? "destructive" : "primary"} disabled={!ready} loading={write.busy === "save"} className="max-md:h-11">{label}</Button>
        </div>
      </form>
    </Dialog>
  );
}
