import type { ComponentType } from "react";
import type { User } from "../api/types";

/** `viewer` = anyone signed in; `operator` = the operator role; `write:<repo>` = GitHub write on that repo. */
export type Permission = "viewer" | "staff" | "operator" | `write:${string}`;

export interface ViewProps {
  /** Route params (`:id`, `:repo` ...). */
  params: Record<string, string | undefined>;
  user: User;
}

export interface PanelDef {
  id: string;
  title: string;
  component: ComponentType<ViewProps>;
  /** Percent of the view's width on desktop. */
  defaultSize: number;
  minSize?: number;
  maxSize?: number;
  collapsible?: boolean;
  /** Collapsed when the user has no saved layout. */
  startCollapsed?: boolean;
  /** Left out of the stacked phone layout (its content is reachable another way). */
  hideOnPhone?: boolean;
}

export interface ViewDef {
  id: string;
  title: string;
  /** Panels left to right on desktop, top to bottom on phones. */
  panels: PanelDef[];
  /** Replaces the stacked panels on phones when the view needs its own flow. */
  phone?: ComponentType<ViewProps>;
  /** Extra controls rendered in the view header (filters, tabs). */
  toolbar?: ComponentType<ViewProps>;
}

export interface RouteDef {
  /** react-router path, relative to the root (`items/:repo/:number`). */
  path: string;
  view: ViewDef;
  permission?: Permission;
  /** A list page the project picker narrows: it keeps the project in its URL (useProjectInUrl). */
  scoped?: true;
}

export interface Command {
  id: string;
  /** Key sequence as typed: "j", "shift+a", "g d". */
  keys: string;
  label: string;
  group: string;
}

export interface FeatureModule {
  id: string;
  /** Needed to see the module at all; routes may ask for more. */
  permission: Permission;
  routes: RouteDef[];
  /** Global commands this module documents in the shortcut sheet. View-local keys register at runtime. */
  commands?: Command[];
}
