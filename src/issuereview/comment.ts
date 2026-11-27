// The Markdown the issue review step posts on an issue: the review, and a needs-info question to the reporter. The model's
// texts are untrusted: each line is cleaned as the pull request review post cleans them (no mentions, no links outside the
// repo's owner, no raw HTML). The note line that names the model is added by src/github/write.ts. No Node imports.
import { cleanLine, stripLinks } from "../review/post-template.ts";
import type { IssueReview } from "./prompt.ts";

const HOLDS: Record<IssueReview["holds"], string> = { yes: "yes", partly: "partly", no: "no", unclear: "unclear: the issue does not say enough" };
const SIZE: Record<IssueReview["size"], string> = { S: "small", M: "medium", L: "large" };
const MAX_FILES_SHOWN = 10;

/** The closing line: what the review recommends, in the form the pull request reviews end with. */
export function recommendationLine(r: IssueReview, clean: (t: string) => string = (t) => t): string {
  switch (r.recommendation) {
    case "implement": return `Recommendation: implement it. ${clean(r.reason)}`;
    case "backlog": return `Recommendation: keep it open in the backlog. ${clean(r.reason)}`;
    case "needs-info": return `Recommendation: ask the reporter first. ${clean(r.reason)}`;
    case "close": {
      const how = r.close_as === "duplicate" && r.duplicate_of ? `as a duplicate of issue ${r.duplicate_of}` : r.close_as === "completed" ? "as completed" : "as not planned";
      return `Recommendation: close it ${how}. ${clean(r.reason)}`;
    }
  }
}

/** The review comment. `owner`: links to github.com under it stay; `head`: the default branch commit the review read. */
export function issueReviewBody(r: IssueReview, o: { owner?: string; head: string | null; branch: string | null }): string {
  const clean = (t: string, max?: number): string => cleanLine(stripLinks(t.replace(/\s+/g, " "), o.owner), max);
  const list = (title: string, xs: readonly string[]): string => (xs.length ? `${title}\n${xs.map((x) => `- ${x}`).join("\n")}\n\n` : "");
  const claims = r.claims.map((c) => `${c.status}: ${clean(c.claim, 300)} (\`${c.where.replace(/`/g, "")}\`)`);
  const related = r.related.map((x) => `issue ${x.ref.slice(1)}: ${clean(x.note, 300)}`);
  const files = r.files.slice(0, MAX_FILES_SHOWN).map((f) => `\`${f.replace(/`/g, "")}\``);
  const at = o.head ? `Reviewed at ${o.head.slice(0, 7)}${o.branch ? ` of ${o.branch}` : ""}.` : "Reviewed without reading the repository.";
  return `**What it asks:** ${clean(r.asks)}\n\n**Still holds:** ${HOLDS[r.holds]}\n\n`
    + list("Claims checked:", claims) + list("Related:", related)
    + `**Size:** ${SIZE[r.size]}${files.length ? `. Files a fix touches: ${files.join(", ")}${r.files.length > files.length ? ", …" : ""}` : ""}.\n\n`
    + (r.approach ? `**Approach:** ${clean(r.approach)}\n\n` : "")
    + list("Risks:", r.risks.map((x) => clean(x, 300)))
    + `${at}\n\n${recommendationLine(r, (t) => clean(t))}`;
}

/** The question to the reporter, with a ping of their login when it is known. */
export function questionBody(question: string, reporter: string | null, owner?: string): string {
  const text = cleanLine(stripLinks(question.replace(/\s+/g, " "), owner), 1500);
  return reporter && /^[A-Za-z0-9-]+$/.test(reporter) ? `@${reporter} ${text}` : text;
}
