// Duplicate groups and their comparison sets, as pure functions over the stored duplicate state (triage.loadDupeState). Items
// joined by duplicate pairs form a group; the members of one kind (PRs, issues) are compared together in one call (compare.ts),
// and the stored result is current while no member's state has changed, no member joined or left, no issue's text has changed and
// no PR's diff size has moved by more than 20% since the compared head.
import { currentComparison, dupeGroups, kindSets, type DupeGroupPut, type DupeState, type KindSet } from "../data/triage/index.ts";

export {
  compareOf, currentComparison, dueSets, dupeGroups, kindSets, ruleOutcome, setHash, setKey,
  DIFF_SIZE_CHANGE, DROP_PAUSE_MS, RULE_ATTEMPTS, RULE_RETRY_MS, type DupeGroup, type DupeKind, type KindSet,
} from "../data/triage/index.ts";

type Role = "keep" | "close" | "stay";
type Others = { number: number; duplicate?: boolean }[];

/** The id of the group whose lowest member is `lowest`. */
export const groupId = (repo: string, lowest: number): string => `${repo}:dupegroup:${lowest}`;

/**
 * The groups whose comparisons are all current, with the role of each member: the kept item of each kind, the open in-scope members
 * that duplicate it (`close`), and the rest (`stay`). A group with nothing to close is still a group: its roles are the signal.
 */
export function groupPlans(state: DupeState): DupeGroupPut[] {
  const out: DupeGroupPut[] = [];
  for (const g of dupeGroups(state)) {
    const sets = kindSets(state, g).filter((s) => s.members.some((m) => m.state === "OPEN" && m.in_scope));
    if (!sets.length) continue;
    const ready = sets.map((set) => ({ set, cmp: currentComparison(state, set) }));
    if (ready.some((r) => !r.cmp)) continue;
    const items: DupeGroupPut["items"] = [];
    for (const { set, cmp } of ready as { set: KindSet; cmp: NonNullable<ReturnType<typeof currentComparison>> }[]) {
      let others: Others = [];
      try { others = (JSON.parse(cmp.result ?? "null") as { others?: Others } | null)?.others ?? []; } catch { /* no per-member answers */ }
      for (const m of set.members) {
        if (m.number === cmp.kept) { items.push({ number: m.number, kind: set.kind, role: "keep", target: null, detail: null }); continue; }
        const other = others.find((o) => o.number === m.number);
        const dup = set.kind === "issue" || other?.duplicate !== false;
        const role: Role = m.state === "OPEN" && dup && m.in_scope ? "close" : "stay";
        items.push({ number: m.number, kind: set.kind, role, target: role === "close" ? cmp.kept : null, detail: other ? JSON.stringify(other) : null });
      }
    }
    // The kept PR is linked to the kept issue.
    const keepPr = items.find((i) => i.role === "keep" && i.kind === "pr"), keepIssue = items.find((i) => i.role === "keep" && i.kind === "issue");
    if (keepPr && keepIssue) keepPr.detail = JSON.stringify({ ...(keepPr.detail ? JSON.parse(keepPr.detail) as object : {}), link: keepIssue.number });
    const sources = ready.map((r) => r.cmp!.source);
    out.push({
      id: groupId(g.repo, Math.min(...items.map((i) => i.number))), repo: g.repo, items,
      source: sources.includes("rule") ? "rule" : sources.every((s) => s === "closed" || s === "single") ? "closed" : "model",
    });
  }
  return out;
}

/**
 * The stored groups that stay beside `groupPlans`: those of a group waiting for a comparison, until it has been made. A stored group
 * keeps its members that are still in such a group; one whose edges are gone, or whose comparisons are all current, is left out.
 */
export function waitingGroups(state: DupeState, stored: DupeGroupPut[]): DupeGroupPut[] {
  const waiting = new Set<string>();
  for (const g of dupeGroups(state)) {
    const sets = kindSets(state, g).filter((s) => s.members.some((m) => m.state === "OPEN" && m.in_scope));
    if (sets.some((s) => !currentComparison(state, s))) for (const n of g.members) waiting.add(`${g.repo}#${n}`);
  }
  const out: DupeGroupPut[] = [];
  for (const g of stored) {
    const items = g.items.filter((i) => waiting.delete(`${g.repo}#${i.number}`));
    if (items.length > 1) out.push({ ...g, id: groupId(g.repo, Math.min(...items.map((i) => i.number))), items });
  }
  return out;
}
