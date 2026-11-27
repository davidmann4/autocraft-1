import type { Selectable } from "kysely";
import type { DB } from "../../db/types.ts";
import type { OutcomePush } from "../../core/evidence.ts";
import type { InstanceConfig } from "./settings.ts";

/** The repos a viewer may not see; a list from the dashboard carries the visible repos in `visible`. */
export type HiddenRepos = string[] & { visible?: string[] };

export type Step = "merge" | "push" | "comment" | "fixissue" | "labels" | "mainfix" | "prstatus" | "ci";
export type StepApproval = { by: string; at: string };
export type StepApprovals = Partial<Record<Step, StepApproval>>;
export type RepoNeed = Step | "pipeline";
export type RepoGuard = { approvals: StepApprovals; pipelineOn: boolean };
export type TrackedRepo = { name: string; pipeline: boolean; addedBy: string | null; addedAt: string | null };

export type TripRow = { stage: string; active: boolean; reason: string; evidence: string[]; trippedAt: string; clearedAt: string | null; clearedBy: string | null };
export type LimitRow = { step: string; perDay: number | null; updatedBy: string | null; updatedAt: string | null; resetAt: string | null };
export type AuditRow = { rowid: number; at: string; login: string; action: string; target: string | null; details: Record<string, unknown> | null };
export type NewAudit = { login: string; action: string; target?: string | null; details?: unknown; at?: string };
export type Details = Record<string, unknown>;

export type AuditWhere = { state?: string; source?: string; card?: number; held?: number; commit?: string };
export type AuditFilter = { targets?: string[]; actions?: string[]; since?: string; until?: string; where?: AuditWhere; order?: "asc" | "desc"; limit?: number };
/** `visible` or `actions` set: a viewer who is not an operator (only `actions` listed; security rows of the `visible` repos). */
export type AuditPageFilter = { login?: string; action?: string; q?: string; before?: number; limit: number; offset: number; visible?: string[]; actions?: string[] };
export type WriteLogRow = { rowid: number; at: string; action: string; target: string | null; state: string | null; identity: string | null; commit: string | null; url: string | null; review: string | null; head: string | null; labels: string[]; jobId: number | null; error: string | null };
export type WritePace = { identity: string; owner: string; bulk: boolean };
export type PaceKey = { action: string; identity: string; owner: string };

export type PushOutcomeRow = Selectable<DB["push_outcomes"]>;
export type NewPush = { action: string; repo: string; number: number | null; from: string | null; to: string; base?: string | null; at?: string };
/** `moves`: the recorded pushes that moved the head, from the head each was made on. */
export type PushFacts = { pushed: Set<string>; movedOffAt: Map<string, string>; moves: OutcomePush[]; brokeHead: string | null };
/** A push about to be made to a pull request. `lines`: how many of its lines it changes. */
export type NewOwnPush = { repo: string; number: number; from: string; to: string; action: string; lines: number | null };
export type TripStageKey = "outside-surge" | string;

export type SettingType = "bool" | "int" | "float" | "text" | "json";
export type SettingScope = "instance" | "repo";
/** One key of the registry: declared once with its type, default, scope and whether it is live (read from a short cache, not the snapshot). */
export type SettingDef = { name: string; type: SettingType; default: unknown; scope: SettingScope; live: boolean; owner: string; shown?: boolean };
export type SettingKey = string;
export type SettingRow = { key: SettingKey; repo: string | null; value: string | null; def: SettingDef | null };
export type SettingPatch = { key: SettingKey; repo?: string; value: string | null };

/** Everything the pass and every job needs: all settings rows, tracked repos, step approvals, active trips and limits. */
export type ControlSnapshot = {
  settings: Map<string, string | null>;
  tracked: Map<string, TrackedRepo>;
  approvals: Map<string, StepApprovals>;
  trips: Map<string, TripRow>;
  limits: Map<string, LimitRow>;
};
export type RepoConfig = { readonly optionalChecks: string[]; readonly prBuildsScope: "all" | "outside"; readonly batchSize: number; readonly testRepo: boolean; buildFeature(feature: string): boolean };
/** Typed instance properties of the registry (`SETTINGS` in settings.ts) plus the per-repo accessor. */
export type Config = InstanceConfig & { repo(repo: string): RepoConfig };
/** The live keys with their defaults applied (`stepParallel` is Infinity for "none"). */
export type LiveConfig = { pipelineEnabled: boolean; drain: boolean; changedBy: string | null; changedAt: string | null; jevParallel: number; stepParallel: number };
export type StageDefaults = Record<string, number | null>;
