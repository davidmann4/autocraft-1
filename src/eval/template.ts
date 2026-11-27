// The issue and comment the self-evaluation posts on the eval repo. Fixed layout; the variable parts are the model's
// investigation (cleaned like other public text) and the records, named only by their ids, times and public item refs.
// No logins, host names or private repository names reach the text.
import { cleanLine } from "../review/post-template.ts";
import { issueText, issueTitle } from "../postmerge/template.ts";
import type { EvalCause, EvalEvidence } from "../data/eval/index.ts";
import type { EvalFinding } from "./prompt.ts";
import { DETECTOR_RULES, type Detector } from "./detect.ts";

export const EVAL_LABEL = { name: "autocraft-eval", color: "5319e7", description: "Found by AutoCraft's hourly self-evaluation" };
export const EVAL_BODY_MAX = 6000;
/** Records an issue or comment lists. */
export const RECORDS_SHOWN = 12;

const hhmm = (at: string): string => `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;
const KIND: Record<string, string> = { job: "job", call: "model call", wf: "workflow", audit: "audit row", answer: "answer", check: "health check", item: "pull request" };

/** One record as public text: its kind and id, its time, and the item when its repo is public. */
function record(e: EvalEvidence, isPublic: (repo: string) => boolean): string {
  const [kind = "", ...rest] = e.id.split(":");
  const id = kind === "check" || kind === "item" ? "" : rest.join(":");
  const item = e.ref && isPublic(e.ref.repo) ? ` on \`${e.ref.repo}#${e.ref.number}\`` : e.ref ? " on an item in a private repository" : "";
  const what = kind === "item" ? (e.ref && isPublic(e.ref.repo) ? `pull request \`${e.ref.repo}#${e.ref.number}\`` : "a pull request in a private repository") : `${KIND[kind] ?? kind}${id ? ` ${cleanLine(id, 60)}` : ""}${item}`;
  return `- ${what}, ${hhmm(e.at)}`;
}

function records(list: readonly EvalEvidence[], isPublic: (repo: string) => boolean): string {
  const shown = list.slice(0, RECORDS_SHOWN).map((e) => record(e, isPublic));
  return [...shown, ...(list.length > RECORDS_SHOWN ? [`- and ${list.length - RECORDS_SHOWN} more`] : [])].join("\n");
}

export function evalIssueTitle(f: EvalFinding): string {
  return issueTitle(f.title);
}

/** The issue body: what the detector saw, the investigation's cause with its path:line evidence, the records, the proposed fix. */
export function evalIssueBody(c: EvalCause, f: EvalFinding, isPublic: (repo: string) => boolean, previous: number | null): string {
  const code = f.evidence.map((e) => `- \`${e.where.replace(/`/g, "")}\`: ${cleanLine(issueText(e.what), 300)}`).join("\n");
  const text = [
    `Found by the hourly self-evaluation. Detector \`${c.detector}\`: ${DETECTOR_RULES[c.detector as Detector] ?? ""}`,
    `Severity: ${f.severity}. Cause key: \`${c.key}\`. Seen ${c.seen} times between ${hhmm(c.firstSeen)} and ${hhmm(c.lastSeen)}.`,
    ...(previous ? [`This cause was reported before in issue ${previous}, closed as completed; it came back.`] : []),
    `## What happens\n\n${issueText(f.cause)}`,
    `## Where in the code\n\n${code}`,
    `## Records\n\n${records(c.evidence, isPublic)}`,
    `## Proposed fix\n\n${issueText(f.fix)}`,
  ].join("\n\n");
  return `${text.slice(0, EVAL_BODY_MAX)}\n`;
}

/** The comment for new evidence on an open issue: how much more, and the newest records. */
export function evalComment(c: EvalCause, isPublic: (repo: string) => boolean): string {
  const added = c.seen - c.reportedSeen;
  const text = `Seen ${added} more time${added === 1 ? "" : "s"} since the last report (${c.seen} in all, last ${hhmm(c.lastSeen)}).\n\n${records(c.evidence.slice(0, Math.max(1, Math.min(added, RECORDS_SHOWN))), isPublic)}`;
  return `${text.slice(0, EVAL_BODY_MAX)}\n`;
}
