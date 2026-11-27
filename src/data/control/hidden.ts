// Pure helpers of the viewer's repo filter (M05 control-a); the SQL form is `hiddenRepos` in fragments.ts.
import type { HiddenRepos } from "./types.ts";

/** Whether the viewer may not see the repo. */
export function isHiddenRepo(h: HiddenRepos, repo: string): boolean {
  return h.visible ? !h.visible.includes(repo) : h.includes(repo);
}

/** Whether any filter applies (operators get an empty list without `visible`). */
export function filtered(h: HiddenRepos): boolean {
  return !!h.visible || h.length > 0;
}

const namePatterns = new WeakMap<string[], RegExp | null>();

/** Matches a hidden repo name only as a whole name: "craft" is not found in "designcraft" or "craft-launcher". */
export function hiddenPattern(hidden: string[]): RegExp | null {
  let re = namePatterns.get(hidden);
  if (re === undefined) {
    re = hidden.length ? new RegExp(`(?<![\\w.-])(?:${hidden.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\w-]|\\.[\\w-])`) : null;
    namePatterns.set(hidden, re);
  }
  return re;
}

/** Free text that quotes a hidden repo's item is left out whole. */
export function blankIfHidden<T extends string | null | undefined>(text: T, hidden: HiddenRepos): T | "" {
  const re = text ? hiddenPattern(hidden) : null;
  return text && re?.test(text) ? "" : text;
}
