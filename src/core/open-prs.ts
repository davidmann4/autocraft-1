// What the Implement stage and the planner read about open PRs and issue text; the open PRs come from mirror.loadOpenPrLinks.
import { createHash } from "node:crypto";
import type { Db } from "../db/index.ts";
import { loadOpenPrLinks } from "../data/mirror/index.ts";
import type { OpenPrRow } from "../data/mirror/types.ts";

export const textHash = (title: string, body: string): string => createHash("sha256").update(title).update("\0").update(body).digest("hex").slice(0, 16);

/** A closing or addressing keyword followed by a same-repo issue number. */
const CLOSING = /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?|address(?:es|ed)?)\s*:?\s+#(\d+)/gi;
const MENTION = /(?<![\w/])#(\d+)/g;

/** Text without links: a reference inside a URL, an HTML link or a markdown link (dependabot's release notes) is not a reference to the repo's own issue. */
const withoutLinks = (t: string): string => t.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, " ").replace(/\[[^\]]*\]\([^)]*\)/g, " ").replace(/https?:\/\/\S+/g, " ");

/** The open PR of an issue: `closes` (it holds the issue) when it has a closing-issue link or a Fixes/Closes/Resolves/Addresses #n, else it only mentions the issue. */
export type OpenPr = { number: number; closes: boolean };

/**
 * The issue numbers a PR's title and body name, as stored in `items.text_refs`: JSON [closes, mentions], each in first-match order without repeats.
 * `closes` follow a closing or addressing keyword; `mentions` are every #n (closes included).
 */
export function textRefs(title: string | null, body: string | null): string {
  const text = withoutLinks(`${title ?? ""}\n${body ?? ""}`);
  const closes = new Set<number>(), mentions = new Set<number>();
  for (const m of text.matchAll(CLOSING)) closes.add(Number(m[1]));
  for (const m of text.matchAll(MENTION)) mentions.add(Number(m[1]));
  return JSON.stringify([[...closes], [...mentions]]);
}

/**
 * Issues an open PR in the repo closes or addresses (any author), and issues a person's open PR mentions by number
 * (a bot's PR, such as a dependency update, is not asked about its mentions). A PR that closes an issue wins over one that mentions it.
 */
export async function issuesWithOpenPr(db: Db, repo: string): Promise<Map<number, OpenPr>> {
  return openPrMap(await loadOpenPrLinks(db, [repo]));
}

/** issuesWithOpenPr() for every repo, from one reading of the open PRs. */
export async function issuesWithOpenPrAll(db: Db): Promise<(repo: string) => Map<number, OpenPr>> {
  return openPrsByRepo(await loadOpenPrLinks(db));
}

/** issuesWithOpenPrAll over loaded open-PR rows (mirror.loadOpenPrLinks). */
export function openPrsByRepo(rows: readonly OpenPrRow[]): (repo: string) => Map<number, OpenPr> {
  const by = new Map<string, OpenPrRow[]>();
  for (const p of rows) (by.get(p.repo) ?? by.set(p.repo, []).get(p.repo)!).push(p);
  return (repo) => openPrMap(by.get(repo) ?? []);
}

const parseRefs = (s: string): [number[], number[]] => {
  try {
    const v = JSON.parse(s) as unknown;
    if (Array.isArray(v) && Array.isArray(v[0]) && Array.isArray(v[1])) return [v[0].filter((n) => typeof n === "number"), v[1].filter((n) => typeof n === "number")];
  } catch { /* computed from the text below */ }
  return [[], []];
};

function openPrMap(prs: readonly OpenPrRow[]): Map<number, OpenPr> {
  const out = new Map<number, OpenPr>();
  for (const p of prs) {
    const [textCloses, mentions] = parseRefs(p.text_refs ?? textRefs(p.title ?? null, p.body ?? null));
    const closes = new Set<number>();
    try {
      for (const n of JSON.parse(p.closing_issues ?? "[]") as unknown[]) if (typeof n === "number") closes.add(n);
    } catch { /* fall through to the text */ }
    for (const n of textCloses) closes.add(n);
    for (const n of closes) out.set(n, { number: p.number, closes: true });
    if (/\[bot\]$/i.test(p.author ?? "")) continue;
    for (const n of mentions) if (!out.has(n)) out.set(n, { number: p.number, closes: false });
  }
  return out;
}

/** Whether an open PR in the repo closes issue `n`. */
export const closedByOpenPr = async (db: Db, repo: string, n: number): Promise<boolean> => !!(await issuesWithOpenPr(db, repo)).get(n)?.closes;
