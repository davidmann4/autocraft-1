// The commits our pipeline pushed to a PR between two heads, for the review prompt and for carrying a verdict over our own fix-up.
import type { Db } from "../db/index.ts";
import { loadPushEdges, madeBy as pushMadeBy, type PushEdge } from "../data/changes/index.ts";
import { loadFixesAsked } from "../data/review/index.ts";

export type OurCommit = { kind: "fix-up" | "pre-merge fix" | "operator fix-up" | "CI fix" | "base merge"; sha: string; note: string; fixes_meant: string[]; from: string };

type Row = { from: string; kind: OurCommit["kind"]; note: string | null; source?: string | null };

/** The commit of ours that made `head`, or null when no push of ours ended there (a contributor's commit). */
function madeBy(edges: readonly PushEdge[], head: string): Row | null {
  const m = pushMadeBy(edges, head);
  if (!m) return null;
  if (m.kind === "fixup") return { from: m.from, kind: m.source === "premerge" ? "pre-merge fix" : m.source === "operator" ? "operator fix-up" : "fix-up", note: m.reason, source: m.source };
  if (m.kind === "cifix") return { from: m.from, kind: "CI fix", note: m.reason ?? `fix for the failing ${m.ciKind} check` };
  return { from: m.from, kind: "base merge", note: m.reason ?? "merged the base branch into the PR" };
}

type OurPath = { commits: OurCommit[]; complete: boolean; sources: (string | null | undefined)[] };

/** The way back from `head`: the push rows, newest first, until `earlier` or a commit that is not ours. */
function walk(edges: readonly PushEdge[], earlier: string, head: string): { rows: { sha: string; row: Row }[]; complete: boolean } {
  const rows: { sha: string; row: Row }[] = [];
  let h = head;
  for (let i = 0; i < 20 && h !== earlier; i++) {
    const row = madeBy(edges, h);
    if (!row) break;
    rows.unshift({ sha: h, row });
    h = row.from;
  }
  return { rows, complete: h === earlier };
}

const pathOf = (rows: { sha: string; row: Row }[], complete: boolean, asked: (from: string) => string[]): OurPath => ({
  commits: rows.map(({ sha, row }) => ({ kind: row.kind, sha, from: row.from, note: row.note ?? "", fixes_meant: row.kind === "fix-up" ? asked(row.from) : [] })),
  complete, sources: rows.map((r) => r.row.source),
});

/**
 * Our commits that lead from `earlier` to `head`, oldest first. `complete` is false when the way back from `head` meets a commit that
 * is not ours before it reaches `earlier` (a contributor pushed in between), so the list then holds only the newest part.
 */
export async function ourCommitsSince(db: Db, repo: string, number: number, earlier: string, head: string): Promise<OurPath> {
  const edges = (await loadPushEdges(db, [{ repo, number }])).get(`${repo}#${number}`) ?? [];
  const { rows, complete } = walk(edges, earlier, head);
  const froms = rows.filter((r) => r.row.kind === "fix-up").map((r) => ({ repo, number, head: r.row.from }));
  const asked = await loadFixesAsked(db, froms);
  return pathOf(rows, complete, (from) => asked.get(`${repo}#${number}@${from}`) ?? []);
}

/**
 * ourCommitsSince() from one PR's stored pushes. The commits carry no `fixes_meant`: the callers read only whether the path is
 * complete and which commits it has.
 */
export function ourPathIn(edges: readonly PushEdge[], earlier: string, head: string): OurPath {
  const { rows, complete } = walk(edges, earlier, head);
  return pathOf(rows, complete, () => []);
}
