// The project: one repo the list pages are narrowed to, or null for every repo. The server narrows its list routes to the
// `x-autocraft-scope` header. The picked project is saved in the browser; a list page's URL names its project first
// (a `repo` parameter), so a copied link shows the same list, and opening one leaves the pick as it was.
// Every other page (an item, settings) has no project and shows every repo.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { matchPath, useLocation, useSearchParams } from "react-router-dom";

export const SCOPE_HEADER = "x-autocraft-scope";
/** The name that stands for every repo in an old `/projects/all` link. */
export const ALL = "all";
const KEY = "autocraft:scope";

const read = (): string | null => {
  try {
    return localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
};

let scope = read();
const listeners = new Set<() => void>();

/** The picked project. */
export const getScope = (): string | null => scope;

export function setScope(next: string | null): void {
  if (next === scope) return;
  scope = next;
  try {
    if (next) localStorage.setItem(KEY, next);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage off: the pick lasts until the page reloads */
  }
  listeners.forEach((fn) => fn());
}

function onScopeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useScope(): string | null {
  return useSyncExternalStore(onScopeChange, getScope);
}

let listPages: string[] = [];
/** The route paths of the list pages (RouteDef `scoped`); the registry sets them once. */
export const setListPages = (paths: string[]): void => void (listPages = paths.map((p) => (p.startsWith("/") ? p : `/${p}`)));

/**
 * The project a page shows: on a list page the one repo its URL names, else the pick; `elsewhere`
 * (none by default) on every other page. A URL naming several repos names no project.
 */
export function projectOf(pathname: string, search: string, pick: string | null, elsewhere: string | null = null): string | null {
  if (!listPages.some((path) => matchPath(path, pathname))) return elsewhere;
  const repo = new URLSearchParams(search).get("repo");
  if (repo !== null) return repo && !repo.includes(",") ? repo : null;
  return pick;
}

/** The project of the current page, for its requests and their cache keys. */
export function usePageProject(): string | null {
  const { pathname, search } = useLocation();
  return projectOf(pathname, search, useScope());
}

/**
 * The project for the navigation's badges: the page's project, or the pick on a page that has none (`/`, an item,
 * settings), so a badge counts what its link opens and doesn't jump when the page changes.
 */
export function useNavProject(): string | null {
  const { pathname, search } = useLocation();
  const pick = useScope();
  return projectOf(pathname, search, pick, pick);
}

/**
 * A list page keeps its project in its URL, so a copied link shows the same list: with a pick and no `repo` it puts the pick
 * there, and a new pick replaces the page's `repo`. Neither adds a history entry.
 */
export function useProjectInUrl(): void {
  const pick = useScope();
  const [params, setParams] = useSearchParams();
  const last = useRef(pick);
  useEffect(() => {
    const picked = last.current !== pick;
    last.current = pick;
    const repo = params.get("repo");
    if (picked ? repo === pick : !pick || repo !== null) return;
    setParams((p) => (pick ? p.set("repo", pick) : p.delete("repo"), p), { replace: true });
  }, [pick, params, setParams]);
}

let current: string | null = null;

/** Runs `start` with `project` as the project of each request it starts. Every Api GET starts its request synchronously, so the call must be made inside `start`. */
export function withProject<T>(project: string | null, start: () => T): T {
  const before = current;
  current = project;
  try {
    return start();
  } finally {
    current = before;
  }
}

/** The project of the request being started (see withProject). */
export const requestProject = (): string | null => current;
