// The current default-branch head of a repo, from the mirror's stored main-CI heads. Internal to the build module.
// reads: mirror.main_ci (through mirror.fragments.mainHeadsOf)
import type * as kx from "../../db/kx.ts";
import { mainHeadsOf } from "../mirror/fragments.ts";

/**
 * A scalar subquery: the head the latest main-CI poll saw for the repo in `repo`. Every poll refreshes `updated_at` of the head it
 * reads, so this stays right after the branch is force-pushed back to a commit older than one stored earlier.
 */
export const headOf = (eb: kx.AnyEb, repo: string) =>
  mainHeadsOf(eb, repo).clearSelect().select("mh.head_sha").orderBy("mh.updated_at", "desc").orderBy("mh.first_seen_at", "desc").limit(1) as any;
