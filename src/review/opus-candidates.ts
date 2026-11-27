// Which PRs the Opus review looks at: the PRs whose Plan holds a `review` action (no Opus verdict at
// the current head commit, or one older than a comment or review by someone else).
import { onAutoPath } from "../core/decide.ts";
import { CLI_BY, type By } from "../core/gates.ts";
import { planned } from "../core/select.ts";
import type { PrFacts } from "../core/plan.ts";
import { type Size } from "../core/rules.ts";
import type { Db } from "../db/index.ts";
import { loadItems } from "../data/mirror/index.ts";

export type OpusCandidate = {
  repo: string; number: number; title: string; body: string; author_association: string | null;
  head_oid: string; lines_changed: number; size: Size; score: number | null;
  /** Nobody started it: it is reviewed only to merge by the rule. */
  auto?: boolean;
};

const candidateOf = (it: { title: string | null; body: string | null; author_association: string | null } | undefined, f: Pick<PrFacts, "repo" | "number" | "lines" | "size" | "score">, head: string, fallbackTitle: string): OpusCandidate =>
  ({ repo: f.repo, number: f.number, title: it?.title ?? fallbackTitle, body: it?.body ?? "", author_association: it?.author_association ?? null, head_oid: head, lines_changed: f.lines, size: f.size, score: f.score });

/** The candidate of a PR at `head`: its text and author association from the items row, size and score from its facts. */
export async function opusCandidateOf(db: Db, f: Pick<PrFacts, "repo" | "number" | "lines" | "size" | "score">, head: string, fallbackTitle = ""): Promise<OpusCandidate> {
  return candidateOf((await loadItems(db, [{ repo: f.repo, number: f.number }], "text")).get(`${f.repo}#${f.number}`), f, head, fallbackTitle);
}

/** PRs of `repo` still to review, highest work score first; `approved`: only those approved for merge, or only the others. */
export async function selectOpusCandidates(db: Db, repo: string, run?: string | null, by: By = CLI_BY, approved?: boolean): Promise<OpusCandidate[]> {
  const rows = await planned(db, "review", { repo, by, ...(run !== undefined ? { run } : {}), ...(approved !== undefined ? { approved } : {}) });
  const items = await loadItems(db, rows.map((p) => ({ repo: p.facts.repo, number: p.facts.number })), "text");
  return rows.map((p) => ({ ...candidateOf(items.get(`${p.facts.repo}#${p.facts.number}`), p.facts, p.action.head!, ""), auto: onAutoPath(p.facts) }));
}
