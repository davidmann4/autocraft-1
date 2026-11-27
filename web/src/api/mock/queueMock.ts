// Fake merge queue: the merge fixtures behind one repo filter, with in-memory holds and batch controls.
import type { Api } from "../client";
import type { MergeWait, NextMerge, QueueBatch, QueueMergeRow, QueueOrigin, QueuePage, QueuePendingRow, QueueRow, User, WeightPlace } from "../types";
import { PIPELINE_REPOS, queueBatches, queueRows } from "./queueFixtures";
import { heldItems } from "./heldMock";

const WAITS: Record<string, [MergeWait, string, number]> = {
  ready: ["ready", "Ready", 0],
  "decision-answered-merge": ["ready", "Merge approved", 0],
  refused: ["refused", "Refused; tried again when GitHub reports something new", 1],
  "in-batch": ["batch-ci", "In a batch; waiting for the batch PR's CI", 1],
  "batch-checking": ["batch-check", "In a batch; checked in the sandbox", 1],
  "waiting-ci": ["ci", "Waiting for CI", 2],
  "waiting-premerge": ["premerge", "Waiting for the pre-merge review", 2],
  "waiting-verify": ["verify", "Waiting for Verify", 2],
};

export function createQueueMock(me: User, changed: () => void): Pick<Api, "queuePage" | "queueControl" | "controls"> {
  const wait = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), 40));
  const allMerge = queueRows();
  const fixtureBatches = queueBatches();
  const originOf = (r: QueueRow): QueueOrigin => {
    if (r.path === "operator") return { how: "answer", by: r.number % 2 ? "mira-ops" : "jonas-k", at: r.reviewedAt };
    if (r.number % 7 === 0) return { how: "queued", by: "mira-ops", at: r.reviewedAt };
    if (r.number % 11 === 0) return { how: "preapproved", by: "jonas-k", at: r.reviewedAt };
    return { how: "review", by: null, at: r.reviewedAt };
  };
  const hold = (ref: string) => {
    const row = [...allMerge, ...fixtureBatches.flatMap((b) => b.prs)].find((r) => key(r) === ref);
    heldItems.set(ref, { title: row?.title ?? ref, kind: "pr", line: `Held by ${me.login}, ${new Date().toISOString().slice(11, 16)} UTC` });
  };
  const removed = new Set<string>();
  const stopped = new Set<number>();
  const key = (r: { repo: string; number: number }) => `${r.repo}#${r.number}`;
  const need = () => {
    if (me.role === "viewer") throw new Error("not allowed");
  };
  // Weights of a few started items: heavier ones go first.
  const weighted = allMerge.filter((r) => r.repo === "designcraft").slice(0, 3);
  const pos = (r: { repo: string; number: number }): WeightPlace | null => {
    const i = weighted.findIndex((w) => key(w) === key(r));
    return i < 0 ? null : { position: i + 1, of: weighted.length, weight: 10 - 2 * i };
  };
  const rank = (r: { repo: string; number: number }) => pos(r)?.position ?? Infinity;
  const byWeight = <T extends { repo: string; number: number }>(rows: T[]) => [...rows].sort((a, b) => rank(a) - rank(b));

  return {
    async queuePage(f) {
      const tab = f.tab ?? "merge";
      const repos = f.repos ?? "pipeline";
      const inScope = (repo: string) => (repos === "all" ? true : repos === "pipeline" ? PIPELINE_REPOS.includes(repo) : repo === repos);
      const batches: QueueBatch[] = fixtureBatches
        .filter((b) => (b.state === "open" || b.state === "checking") && inScope(b.repo))
        .map((b) => ({ ...b, prs: b.prs.filter((p) => !removed.has(key(p)) && !heldItems.has(key(p)) && !stopped.has(b.id)) }))
        .filter((b) => !stopped.has(b.id));
      const inBatch = new Set(batches.flatMap((b) => b.prs.map(key)));
      const returned = fixtureBatches.filter((b) => stopped.has(b.id)).flatMap((b) => b.prs);
      const base = [...allMerge, ...returned, ...fixtureBatches.flatMap((b) => b.prs).filter((p) => removed.has(key(p)))];
      const seen = new Set<string>();
      const entries = base
        .filter((r) => !seen.has(key(r)) && !!seen.add(key(r)))
        .map((r): QueueMergeRow => ({ ...r, state: inBatch.has(key(r)) ? r.state : r.state === "in-batch" || r.state === "batch-checking" ? "ready" : r.state, place: pos(r), added: originOf(r) }))
        .filter((r) => r.state !== "merged" && inScope(r.repo) && !heldItems.has(key(r)));
      // Approved for merge, no take review yet.
      const pending: QueuePendingRow[] = [
        { repo: "designcraft", number: 3311, kind: "pr" as const, title: "Keep the swatch order when importing a palette", author: "contributor", size: "S" as const, step: "fixup" as const, added: { how: "queued" as const, by: "operator", at: new Date(Date.now() - 3600_000).toISOString() } },
        { repo: "designcraft", number: 3317, kind: "pr" as const, title: "Frame tool: snap to the baseline grid", author: "contributor", size: "M" as const, step: "review" as const, added: { how: "preapproved" as const, by: "operator", at: new Date(Date.now() - 1800_000).toISOString() } },
      ].filter((r) => inScope(r.repo));
      const merge = entries.length + pending.length;
      const counts = { all: merge, review: 0, fix: 0, verify: 0, merge };
      const out: QueuePage = { tab, repos, counts, rows: [], mergeRows: [], nextMerges: [], batches: [], total: 0, next: null };
      const offset = f.offset ?? 0, limit = f.limit ?? 100;
      const free = byWeight(entries.filter((e) => !inBatch.has(key(e))));
      out.mergeRows = free.slice(offset, offset + limit);
      out.total = free.length;
      out.next = offset + out.mergeRows.length < free.length ? offset + out.mergeRows.length : null;
      out.pending = pending;
      out.batches = batches.map((b) => ({ ...b, prs: b.prs.map((p): QueueMergeRow => ({ ...p, place: pos(p), added: originOf(p) })) }));
      const batchOf = new Map(batches.flatMap((b) => b.prs.map((p) => [key(p), { id: b.id, branch: b.branch }] as const)));
      const items = entries.flatMap((e) => {
        const w: [MergeWait, string, number] | undefined = WAITS[e.state];
        return w ? [{ e, w }] : [];
      });
      items.sort((a, b) => rank(a.e) - rank(b.e) || a.w[2] - b.w[2]);
      out.nextMerges = items.slice(0, 10).map(({ e, w }): NextMerge => ({ repo: e.repo, number: e.number, title: e.title, waitsFor: w[0], label: w[1], batch: batchOf.get(key(e)) ?? null }));
      return wait(out);
    },
    controls: {
      async run(input) {
        need();
        return { ok: true, line: `Resumed ${input.key}` };
      },
    },
    queueControl: {
      async batchRemove(item) {
        need();
        removed.add(item);
        hold(item);
        changed();
      },
      async stopBatch(id) {
        need();
        stopped.add(id);
        for (const p of fixtureBatches.find((b) => b.id === id)?.prs ?? []) hold(key(p));
        changed();
      },
    },
  };
}
