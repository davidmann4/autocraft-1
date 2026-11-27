// Constants and pure helpers of the triage rules for issues and PRs, shared by decide-item.ts and the loader. No imports.
// Each constant mirrors the old module named in its comment; test/decide-item.test.ts checks they stay equal.

/** The scope labels: which of them an item is stays a person's call, so a disagreement among them is not refereed. */
export const SCOPE_LABELS: readonly string[] = ["missing feature", "small extra", "plugin candidate"];
export const isScope = (l: string | null): boolean => l !== null && SCOPE_LABELS.includes(l);

/** Type labels, exclusive on an item (labels/set.ts TYPE_LABELS). */
export const TYPE_LABEL_NAMES = ["bugfix", "performance", "missing feature", "small extra", "plugin candidate", "infra"];
export const isTypeLabel = (name: string): boolean => TYPE_LABEL_NAMES.includes(name.toLowerCase());
export const sameLabel = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
/** Opus answers the label referee may fail to give for an item before its label stands unsure; a failed item is asked again after REFEREE_RETRY_MS. */
export const REFEREE_MAX_FAILURES = 3;
export const REFEREE_RETRY_MS = 60 * 60_000;

/** The labels a pass would add to the item: its settled type, the security and needs-decision flags. Null when nothing is settled or a type label conflicts. */
export function labelsToAdd(settled: { type: string; security: boolean; needsDecision: boolean } | null, existing: string[]): string[] | null {
  const s = settled;
  if (!s) return null;
  if (existing.some((l) => isTypeLabel(l) && !sameLabel(l, s.type))) return null;
  const want = [s.type, ...(s.security ? ["security"] : []), ...(s.needsDecision ? ["needs decision"] : [])];
  return want.filter((w) => !existing.some((e) => sameLabel(e, w)));
}

/** The previous label pass (its "labeled" stage note, "added: a, b") already added every label in `add`. */
export function alreadyLabeled(note: string | null, add: string[]): boolean {
  if (!note) return false;
  const done = note.replace(/^added: /, "").split(", ");
  return add.every((a) => done.some((d) => d.toLowerCase() === a.toLowerCase()));
}
