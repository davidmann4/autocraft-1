// "Queue items": a button on the Merge queue tab that opens a dialog to add several PRs and issues at once, one GitHub link or id per
// line. A PR is pre-approved at its current head and fast-tracked with the chosen weight; an issue is fast-tracked, and the one open PR
// that closes it is queued too. For operators, and for maintainers who settle decisions (maintainer writes on, write access to a repo);
// the server checks each line's repo. Weights are set by operators, so a maintainer's dialog has no weight and the server uses the default.
// "Bypass checks" queues the lines with bypass checks: the reviews take the items as wanted and the pipeline repairs instead of asking.
import { useState } from "react";
import { CheckCircleIcon, PlusIcon, XCircleIcon } from "@phosphor-icons/react";
import { useApi } from "../../api/client";
import { useUser } from "../../shell/UserContext";
import { Button } from "../../ui/atoms/Button";
import { Select } from "../../ui/atoms/Select";
import { Textarea } from "../../ui/atoms/Textarea";
import { Dialog } from "../../ui/molecules/Dialog";
import { WEIGHT_DEFAULT, WEIGHTS } from "./fastTrack";

type Result = { item: string; ok: boolean; text: string };

/** The non-empty lines, trimmed, each once. */
const linesOf = (text: string) => [...new Set(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];

function QueueDialog({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const operator = useUser().role === "operator";
  const [text, setText] = useState("");
  const [weight, setWeight] = useState(WEIGHT_DEFAULT);
  const [bypass, setBypass] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const items = linesOf(text);

  const submit = async () => {
    setBusy(true);
    const out: Result[] = [];
    // One at a time, so each line gets its own answer and a refusal does not stop the rest.
    for (const item of items) {
      try {
        out.push({ item, ok: true, text: (await api.queueControl.add(item, operator ? weight : undefined, bypass)).label });
      } catch (e) {
        out.push({ item, ok: false, text: (e as Error).message });
      }
      setResults([...out]);
    }
    // What was refused stays in the box to fix and send again.
    setText(out.filter((r) => !r.ok).map((r) => r.item).join("\n"));
    setBusy(false);
  };

  return (
    <Dialog open onClose={onClose} title="Queue items" size="lg">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (items.length && !busy) void submit();
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-ink/65">
          PRs and issues, one per line
          <Textarea
            rows={12}
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"https://github.com/owner/repo/pull/123\nhttps://github.com/owner/repo/issues/124\nrepo#125"}
            className="code text-sm"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {operator && (
            <label className="flex items-center gap-2 text-xs text-ink/65">
              Weight
              <Select value={weight} onChange={(e) => setWeight(Number(e.target.value))}>
                {WEIGHTS.map((w) => (
                  <option key={w} value={w}>
                    {w}
                  </option>
                ))}
              </Select>
            </label>
          )}
          <label className="flex items-center gap-2 text-xs text-ink/65" title="The reviews take scope and design as settled; the pipeline makes pre-merge fixes and repairs red CI and conflicts itself, each push reviewed again, instead of asking; never closed as a duplicate.">
            <input type="checkbox" checked={bypass} onChange={(e) => setBypass(e.target.checked)} className="size-4" aria-describedby="queue-bypass-help" />
            Bypass checks
          </label>
          <span id="queue-bypass-help" className="sr-only">
            The reviews take scope and design as settled; the pipeline makes pre-merge fixes and repairs red CI and conflicts itself, each push reviewed again, instead of asking; never closed as a duplicate.
          </span>
          <Button type="submit" className="ml-auto max-md:h-11" loading={busy} disabled={!items.length}>
            Queue items
          </Button>
        </div>
        {results.length > 0 && (
          <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto border-t border-line pt-2 text-xs">
            {results.map((r) => (
              <li key={r.item} className="flex items-start gap-1.5">
                {r.ok ? <CheckCircleIcon weight="fill" className="mt-0.5 shrink-0 text-ok" aria-label="Done" /> : <XCircleIcon weight="fill" className="mt-0.5 shrink-0 text-bad" aria-label="Refused" />}
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <span className="code">{r.item}</span> <span className={r.ok ? "text-ink/60" : "text-bad"}>{r.text}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </form>
    </Dialog>
  );
}

export function QueueItems() {
  const [open, setOpen] = useState(false);
  const user = useUser();
  if (!(user.role === "operator" || (user.role === "maintainer" && user.maintainerSettles && user.writeRepos.length > 0))) return null;
  return (
    <>
      <Button className="max-md:h-11" onClick={() => setOpen(true)}>
        <PlusIcon aria-hidden /> Queue items
      </Button>
      {open && <QueueDialog onClose={() => setOpen(false)} />}
    </>
  );
}
