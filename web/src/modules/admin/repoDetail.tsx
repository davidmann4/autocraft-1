import { useApi } from "../../api/client";
import type { TrackedRepo } from "../../api/types";
import { Badge } from "../../ui/atoms/Badge";
import { num } from "../../lib/format";
import { useUser } from "../../shell/UserContext";
import { Block } from "../../ui/molecules/Block";
import { Switch } from "../../ui/atoms/Switch";
import { OptionalChecks, WRITES, approvalPatch, type Write, type WriteKind } from "./repoParts";
import { SecuritySection } from "./securityParts";
import { BuildFeatures } from "./buildFeatureParts";

function WriteRow({ r, w, write }: { r: TrackedRepo; w: WriteKind; write: Write }) {
  const api = useApi();
  const me = useUser().login;
  const m = r[w.field];
  const key = `${w.field}:${r.name}`;
  return (
    <li className="flex items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{w.name}</div>
        <div className="text-sm text-ink/60">{w.line}</div>
        {m?.approved && (
          <div className="num text-xs text-ink/50">
            {m.approvedBy} {m.approvedAt ?? ""}
          </div>
        )}
      </div>
      {r.canManage ? (
        <Switch on={!!m?.approved} label={w.name} onChange={(on) => void write.run(key, () => w.run(api, r.name, on), { repo: r.name, patch: approvalPatch(w, on, me) })} />
      ) : m?.approved ? (
        <Badge tone="ok">Approved</Badge>
      ) : (
        <Badge>Not approved</Badge>
      )}
    </li>
  );
}

/** On when every GitHub write of the repo is approved. Switching it on approves the rest in pipeline order; off stops them all. */
function AllWrites({ r, write }: { r: TrackedRepo; write: Write }) {
  const api = useApi();
  const me = useUser().login;
  const key = `all:${r.name}`;
  if (!r.canManage) return null;
  const all = WRITES.every((w) => r[w.field]?.approved);
  return (
    <span className="inline-flex items-center gap-3 text-sm text-ink/60">
      All
      <Switch on={all} label="All GitHub writes" onChange={(on) => {
        const todo = WRITES.filter((w) => !!r[w.field]?.approved !== on);
        const confirmed = new Set<string>();
        void write.run(key, async () => {
          const out: Partial<TrackedRepo> = { name: r.name };
          for (const w of todo) {
            Object.assign(out, { [w.field]: ((await w.run(api, r.name, on)) as TrackedRepo)[w.field] });
            confirmed.add(w.field);
          }
          return out;
        }, { repo: r.name, confirmed, patch: (cur) => Object.assign({}, ...todo.map((w) => approvalPatch(w, on, me)(cur))) });
      }} />
    </span>
  );
}

/** The tracked repo's GitHub writes, build features, optional checks and label plan. */
export function RepoSettings({ r, write, staff }: { r: TrackedRepo; write: Write; staff: boolean }) {
  const l = r.labels;
  return (
    <>
      {staff && <SecuritySection repo={r.name} />}
      <Block className="mt-4" flush title="GitHub writes" aside={<AllWrites r={r} write={write} />}>
        <ul>
          {WRITES.map((w) => (
            <WriteRow key={w.field} r={r} w={w} write={write} />
          ))}
        </ul>
      </Block>
      <BuildFeatures r={r} write={write} />
      <OptionalChecks r={r} write={write} />
      {l && (
        <Block className="mt-4" title="Labels plan">
          <div className="num flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <span>{num(l.toAdd)} to add</span>
            <span>{num(l.skipped)} skipped</span>
            <span>{num(l.conflicts)} conflicts</span>
          </div>
        </Block>
      )}
    </>
  );
}

