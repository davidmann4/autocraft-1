// What a review is told about a PR that a person queued with bypass checks (Queue items, `queue_pr`, `@<app> merge queue bypass`):
// who did it and the issues the PR builds, as the specification they accepted. The review and the pre-merge review then judge
// whether the code builds that specification correctly and safely, not whether the change is wanted or designed the right way
// (src/prompts/index.ts, "Queued"). A PR queued without bypass checks gets no such field.
import type { Db } from "../db/index.ts";
import type { Queued, QueuedSpec } from "./opus-parse.ts";

/** Issues shown as the specification: at most this many, each body cut to SPEC_BODY_CHARS. */
const SPEC_MAX = 3;
const SPEC_BODY_CHARS = 3000;
/** The live states of a pre-approved merge (ACTIVE in src/preapproval/index.ts). */
const LIVE = ["fixup", "review", "ci", "queued"];

/** Issue numbers a title names as "(#123)" or "#123": the convention for the issue a PR builds. */
export function titleRefs(title: string): number[] {
  return [...new Set([...title.matchAll(/(?<![\w/])#(\d{1,7})\b/g)].map((m) => Number(m[1])))];
}

/** The `queued` field of the review input, or nothing when no person queued the PR with bypass checks. */
export async function queuedField(db: Db, repo: string, number: number): Promise<{ queued?: Queued }> {
  const pre = await db.get(db.k.selectFrom("preapprovals").select(["by", "instructions"]).where("repo", "=", repo).where("number", "=", number)
    .where("state", "in", LIVE).where("bypass", "=", 1).orderBy("id", "desc").limit(1));
  const fast = pre ? undefined : await db.get(db.k.selectFrom("main.fast_track").select("added_by").where("repo", "=", repo).where("number", "=", number).where("bypass", "=", 1));
  if (!pre && !fast) return {};
  const item = await db.get(db.k.selectFrom("items").select(["title", "closing_issues"]).where("repo", "=", repo).where("number", "=", number));
  let closes: number[] = [];
  try { closes = (JSON.parse(item?.closing_issues ?? "[]") as unknown[]).filter((x): x is number => typeof x === "number"); } catch { /* none */ }
  const numbers = (closes.length ? closes : titleRefs(item?.title ?? "")).filter((n) => n !== number).slice(0, SPEC_MAX);
  const spec: QueuedSpec[] = [];
  for (const n of numbers) {
    const r = await db.get(db.k.selectFrom("items").select(["title", "body"]).where("repo", "=", repo).where("number", "=", n).where("kind", "=", "issue"));
    if (r) spec.push({ ref: `${repo}#${n}`, title: r.title ?? "", body: (r.body ?? "").slice(0, SPEC_BODY_CHARS) });
  }
  return { queued: pre
    ? { how: "queued", by: pre.by, instructions: pre.instructions.trim() || null, spec }
    : { how: "fast-tracked", by: fast!.added_by, instructions: null, spec } };
}
