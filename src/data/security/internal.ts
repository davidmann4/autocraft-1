// Shared by the security query files; not exported from index.ts.
import type { ExpressionBuilder } from "kysely";
import * as kx from "../../db/kx.ts";
import type { FindingBriefRow, FindingPatch, StoredFindingState } from "./types.ts";
import { INTERNAL_FINDING_STATES } from "./types.ts";

export const nowIso = (): string => new Date().toISOString();

/** Columns lists leave out of a finding: the large text and JSON ones. */
const BRIEF_OMIT = new Set(["fix_patch", "fix_files", "verification", "refs", "reach", "impact", "fix_summary"]);
/** The `FindingBriefRow` columns of the finding table aliased `alias`. */
export const briefCols = (alias: string): string[] => (kx.cols("security_findings", alias) as readonly string[]).filter((c) => !BRIEF_OMIT.has(c.slice(alias.length + 1)));

/** `CASE severity` ranking most severe first, for the finding named by `col`. */
export const severityRank = (eb: ExpressionBuilder<any, any>, col: string) => eb.case().when(eb(col, "=", "critical")).then(0).when(eb(col, "=", "high")).then(1).when(eb(col, "=", "medium")).then(2).else(3).end();

/** Findings the scan's own bookkeeping holds are never listed. */
export const LISTED_NOT_IN: string[] = [...INTERNAL_FINDING_STATES];

/** The columns of a patch as an update `set`, with the state and `updated_at` it comes with. */
export function patchSet(patch: FindingPatch | undefined, state: StoredFindingState | undefined, at: string): Record<string, unknown> {
  const { bumpFixAttempts: _b, restoreFixAttempts: _r, ...cols } = patch ?? {};
  return { ...(state ? { state } : {}), updated_at: at, ...cols };
}

export type BriefRow = FindingBriefRow;
