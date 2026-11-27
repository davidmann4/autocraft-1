// Outside-author protections on fake data: the three numbers, the tripped surge breaker and the items held for two authors.
import type { HeldAuthor, OutsideState } from "../types";
import { NOW } from "./fixtures";

const at = (min: number) => new Date(NOW - min * 60_000).toISOString();

/** The held items: 7 over an author's daily limit, 2 in the surge. */
let held: { reason: "limit" | "surge"; author: string }[] = [
  ...Array.from({ length: 7 }, () => ({ reason: "limit" as const, author: "wren-lat" })),
  ...Array.from({ length: 2 }, () => ({ reason: "surge" as const, author: "kestrel-dev" })),
];

export const outside: OutsideState = {
  prsPerDay: 5, issuesPerDay: 5, surgePerHour: 30, heldByLimit: 7, heldBySurge: 2, authors: 2,
  tripped: { reason: "41 new items from outside authors in the last hour (more than 30)", since: at(18) },
};

const recount = (): void => {
  outside.heldByLimit = held.filter((r) => r.reason === "limit").length;
  outside.heldBySurge = held.filter((r) => r.reason === "surge").length;
  outside.authors = new Set(held.map((r) => r.author)).size;
};

export function resumeSurge(): void {
  outside.tripped = null;
  held = held.filter((r) => r.reason !== "surge");
  recount();
}

export const heldAuthors = (): HeldAuthor[] =>
  [...new Set(held.map((r) => r.author))].map((author) => {
    const rows = held.filter((r) => r.author === author);
    const issues = Math.floor(rows.length / 3);
    return { author, prs: rows.length - issues, issues, oldest: at(rows.length * 130), surge: rows.some((r) => r.reason === "surge") };
  });

export function releaseAuthor(author: string): number {
  const n = held.filter((r) => r.author === author).length;
  held = held.filter((r) => r.author !== author);
  recount();
  return n;
}
