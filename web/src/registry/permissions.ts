import type { User } from "../api/types";
import type { Permission } from "./types";

export function can(user: User, p: Permission): boolean {
  if (p === "viewer") return true;
  if (p === "staff") return user.role !== "viewer";
  if (p === "operator") return user.role === "operator";
  return user.writeRepos.includes(p.slice("write:".length));
}

/** Whether the user runs the repo (server rule: operator, or maintainer with write). */
export const canRun = (user: User, repo: string): boolean => user.runRepos.includes(repo);

export function roleLabel(user: User) {
  return user.role === "operator" ? "Operator" : user.role === "maintainer" ? "Maintainer" : "Viewer";
}
