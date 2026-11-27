import { useState } from "react";
import { useApi } from "../../api/client";
import type { FindingQuestion } from "../../api/types";
import { useWrite } from "../../lib/hooks";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Textarea } from "../../ui/atoms/Textarea";

/** The finding's actions: pick one, read what it does, add a note, confirm. */
export function FindingActions({ q, repo, number }: { q: FindingQuestion; repo: string; number: number }) {
  const api = useApi();
  const write = useWrite();
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const a = q.actions.find((x) => x.action === picked) ?? null;
  if (!q.canAct) return null;
  const run = () =>
    void write.run("act", async () => {
      await api.security.act(repo, number, a!.action, note.trim() || undefined);
      setPicked(null);
      setNote("");
    });
  return (
    <div className="mt-3 flex flex-col gap-3">
      <div role="group" aria-label={q.text} className="flex flex-wrap gap-2">
        {q.actions.map((x) => (
          <Button key={x.action} variant={x.action === picked ? "primary" : "secondary"} aria-pressed={x.action === picked} className="max-md:h-11" onClick={() => setPicked(x.action === picked ? null : x.action)}>
            {x.label}
          </Button>
        ))}
      </div>
      {a && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-ink/80">{a.label}: {a.does}.</p>
          <Textarea rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder={a.note === "required" ? "Reason" : "Note (optional)"} aria-label={a.note === "required" ? "Reason" : "Note"} />
          <Button variant="primary" className="w-fit max-md:h-11" loading={write.busy === "act"} disabled={a.note === "required" && !note.trim()} onClick={run}>
            {a.writes ? `Confirm ${a.label}` : a.label}
          </Button>
        </div>
      )}
      <ErrorLine error={write.error} />
    </div>
  );
}
