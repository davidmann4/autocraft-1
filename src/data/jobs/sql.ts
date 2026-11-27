// Statement pieces shared by the module's own files (not re-exported by index.ts).
import type { RawBuilder } from "kysely";
import type { Db } from "../../db/index.ts";
import type { AnyEb } from "../../db/kx.ts";
import * as kx from "../../db/kx.ts";
import { hiddenRepos } from "../control/fragments.ts";
import type { HiddenRepos } from "./types.ts";

/** The size in bytes of the UTF-8 text in `col`, as `Buffer.byteLength` counts it. */
export const octets = (db: Db, col: string): RawBuilder<number> => kx.byteLength(db, col);

/** Whether a viewer filter applies (operators get an empty list without `visible`). */
export const hasFilter = (h: HiddenRepos | undefined): h is HiddenRepos => !!h && (!!h.visible || h.length > 0);

/** The job's repo (null for a job without one) is visible to the viewer. */
export const repoVisible = (db: Db, eb: AnyEb, col: string, h: HiddenRepos) => eb.or([eb(col, "is", null), hiddenRepos(db, col, h)]);

/** `NOW` as the text columns hold it. */
export const nowIso = (): string => new Date().toISOString();

/** The item a job names in its params. */
export const numberOf = (db: Db, col = "params") => kx.jsonNum(db, col, "$.number");

/** The job is of the approved lane: its params say `lane: "approved"` (src/runner/steps.ts APPROVED_LANE). */
export const approvedOf = (db: Db, eb: AnyEb, col = "params") => eb(eb.fn.coalesce(kx.jsonText(db, col, "$.lane"), eb.val("")), "=", "approved");

/** The job is of a per-item lane, one PR each: its params say `lane: "approved"` or `lane: "item"` (src/runner/steps.ts). */
export const perItemOf = (db: Db, eb: AnyEb, col = "params") => eb(eb.fn.coalesce(kx.jsonText(db, col, "$.lane"), eb.val("")), "in", ["approved", "item"]);
