// Paths that moved or went: bookmarks, and links posted on GitHub and Discord, open the page that has their content now.
import type { ReactElement } from "react";
import { Navigate, Route, useLocation, useParams } from "react-router-dom";
import { decisionItem, itemPath } from "../lib/links";
import { ALL } from "../api/scope";
import { useUser } from "./UserContext";

/** `search` replaces the query; without it the old query stays. */
function RedirectTo({ to, search }: { to: string; search?: string }) {
  const loc = useLocation();
  return <Navigate to={`${to}${search ?? loc.search}`} replace />;
}

/** Old item links: `/item/<repo>/<n>` and the `<repo>/<n>` form of a decision link. */
function ItemRedirect() {
  const { repo, number } = useParams();
  const n = Number(number);
  return <RedirectTo to={repo && Number.isInteger(n) && n > 0 ? itemPath(repo, n) : "/"} />;
}

/** A decision link by its id opens the item the id names; an id that names none opens Home. */
function DecisionRedirect() {
  const item = decisionItem(useParams().id ?? "");
  return <RedirectTo to={item ? itemPath(item.repo, item.number) : "/"} search="" />;
}

/** The old Needs page: its Stopped tab is the Work queue's waiting list, the rest is the reader's own items. */
function NeedsRedirect() {
  const q = new URLSearchParams(useLocation().search);
  const repo = q.get("repo");
  if (q.get("tab") === "stopped") return <RedirectTo to="/queue" search={repo ? `?repo=${encodeURIComponent(repo)}` : ""} />;
  return <RedirectTo to="/items" search={`?filter=mine${repo ? `&repo=${encodeURIComponent(repo)}` : ""}`} />;
}

/** A project's home is Home narrowed to the repo. */
function ProjectRedirect() {
  const { repo } = useParams();
  return <RedirectTo to="/" search={repo && repo !== ALL ? `?repo=${encodeURIComponent(repo)}` : ""} />;
}

/** Operators' settings are in Admin, a maintainer's own on Runner; a viewer has none. */
function SettingsRedirect({ operator }: { operator: string }) {
  const { role } = useUser();
  return <RedirectTo to={role === "operator" ? operator : role === "maintainer" ? "/runner" : "/"} search="" />;
}

const REDIRECTS: [path: string, element: ReactElement][] = [
  ["item/:repo/:number", <ItemRedirect />],
  ["projects", <RedirectTo to="/" />],
  ["projects/:repo", <ProjectRedirect />],
  ["needs", <NeedsRedirect />],
  ["needs/stopped", <RedirectTo to="/queue" />],
  ["needs/*", <RedirectTo to="/" search="" />],
  ...["decisions", "needs/decisions"].flatMap((p): [string, ReactElement][] => [
    [p, <RedirectTo to="/" search="" />],
    [`${p}/:id`, <DecisionRedirect />],
    [`${p}/:repo/:number`, <ItemRedirect />],
    [`${p}/:repo/:number/:kind`, <ItemRedirect />],
  ]),
  ["queue/merge", <RedirectTo to="/next/merge" />],
  ["queue/*", <RedirectTo to="/next/steps" />],
  ["work", <RedirectTo to="/next/steps" />],
  ["merge-queue", <RedirectTo to="/next/merge" />],
  ["github-activity", <RedirectTo to="/activity" search="?kinds=write" />],
  ["now", <RedirectTo to="/activity" search="" />],
  ["flow", <RedirectTo to="/help/workflows" search="" />],
  ["about/*", <RedirectTo to="/help" search="" />],
  ["reports", <RedirectTo to="/stats" search="" />],
  ["settings", <SettingsRedirect operator="/admin" />],
  ["accounts", <SettingsRedirect operator="/admin/inference" />],
];

export const redirectRoutes = REDIRECTS.map(([path, element]) => <Route key={path} path={path} element={element} />);
