// Operator tool: `autocraft-server fixup try REPO#N` runs the fix-up patch step for one PR as the stage does (the same sandboxed
// model call with the check tool, then apply, validate, the Opus patch check and the lint task) and prints what happened.
// It stores no fixups row, records no check or audit row and writes nothing to GitHub; model usage, model_checks and the
// worker tasks are recorded as for any run. The pipeline setting and the stage's limits do not apply.
import { mkdirSync } from "node:fs";
import { CheckTool, applyCheck, refusal } from "../checktool/index.ts";
import { CHECK_DIFF_CAP, CHECK_PATCH_CAP } from "../patchcheck/types.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { parseCheck, checkLine } from "../patchcheck/index.ts";
import { queueLintFor, readLint } from "../prepush/index.ts";
import { cachedDiff } from "../review/diff.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { parseFixes } from "./candidates.ts";
import { DIFF_CAP, FILE_CAP, TOTAL_CAP, defaultDeps, type FixupDeps } from "./index.ts";
import { shownSize, viewFile } from "./excerpt.ts";
import { Git } from "./git.ts";
import { buildScriptsAt, fixupEditable, validatePatch, type FixupPr } from "./patch.ts";
import { TERMINAL, loadTaskStates } from "../data/build/index.ts";
import { loadModelChecksAfter, maxModelCheckId } from "../data/changes/index.ts";
import { listRuns } from "../data/inference/index.ts";
import { loadItems } from "../data/mirror/index.ts";
import { loadReviewsAt } from "../data/review/index.ts";
import { ownerOf } from "../owners.ts";
import type { Db } from "../db/index.ts";

/** The dev command reads every run, hidden repos included. */
const STAFF = { hidden: [], staff: true };
const LINT_GIVE_UP_MS = 90 * 60_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const indent = (s: string) => s.trimEnd().split("\n").map((l) => `  ${l}`).join("\n");

/** Returns the exit code: 0 clean, 2 when the lint task found something or the Opus check rejected, 1 on an error. */
const BASE_QUERY = `query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $n) { baseRefOid } } }`;

export async function runFixupTry(db: Db, repo: string, number: number, d: FixupDeps = defaultDeps(), log: (line: string) => void = console.log): Promise<number> {
  const ref = `${repo}#${number}`;
  const found = (await loadItems(db, [{ repo, number }], "text")).get(ref);
  const item = found?.kind === "pr" ? found : undefined;
  if (!item?.head_oid) throw new Error(`${ref} is not a PR in the database`);
  const review = (await loadReviewsAt(db, [{ repo, number, head: item.head_oid }])).get(`${ref}@${item.head_oid}`);
  if (!review) throw new Error(`${ref} has no review at its head ${item.head_oid.slice(0, 7)}`);
  if (review.verdict !== "take-fix") throw new Error(`the latest review of ${ref} at its head is ${review.verdict}, not take-fix`);
  const fixes = parseFixes(JSON.stringify(review.fixes));
  if (!fixes.length) throw new Error(`the take-fix review of ${ref} lists no usable fix`);
  const files = [...new Set(fixes.map((f) => f.file))];

  mkdirSync(d.root, { recursive: true });
  const git = new Git(d.exec, d.root, repo);
  const head = await git.fetchPr(ownerOf(repo), repo, number);
  if (head !== item.head_oid) throw new Error(`the PR head is now ${head.slice(0, 7)}, not the reviewed ${item.head_oid.slice(0, 7)}`);
  const scripts = await buildScriptsAt(git, head);
  const bad = files.find((f) => !fixupEditable(f, scripts));
  if (bad) throw new Error(`the fixes name ${bad}, which a fix-up may not edit`);
  const diff = await cachedDiff(db, repo, number, head, d.fetchDiff);
  if (!diff.ok) throw new Error(`no diff: ${diff.error}`);
  if (diff.text.length > DIFF_CAP) throw new Error(`the PR diff is over the ${DIFF_CAP} character limit`);
  const checkout = (await d.checkout?.(repo, number, head)) ?? undefined;
  const repoDir = checkout ? { repo_dir: REPO_PATH } : {};
  const shown: FixupPr["files"] = [];
  let total = 0;
  for (const path of files) {
    const f = await git.file(head, path);
    if (!f.ok) throw new Error(f.reason);
    if (checkout) { shown.push({ path }); continue; }
    const v = viewFile(path, f.content, fixes.filter((x) => x.file === path).map((x) => x.change), diff.text, FILE_CAP);
    if (!v.ok) throw new Error(v.reason);
    total += shownSize(v.file);
    if (total > TOTAL_CAP) throw new Error(`the files named in the fixes are over the ${TOTAL_CAP} character limit`);
    shown.push(v.file);
  }
  log(`${ref} at ${head.slice(0, 7)}: ${fixes.length} fixes in ${files.join(", ")}; ${checkout ? "sandbox checkout ready" : "NO checkout: the model runs without tools"}`);

  const [lastRun, before] = await db.together(() => Promise.all([listRuns(db, { limit: 1 }, STAFF), maxModelCheckId(db)]));
  const before0 = lastRun.rows[0]?.id ?? 0;
  const base = (await d.querier.query(BASE_QUERY, { owner: ownerOf(repo), name: repo, n: number }) as { repository?: { pullRequest?: { baseRefOid?: string } | null } }).repository?.pullRequest?.baseRefOid ?? null;
  const tool = new CheckTool({ db, step: "fixup", repo, number, head, base, applies: applyCheck(git, d.root, head, (p) => refusal(validatePatch(p, files, (x) => fixupEditable(x, scripts)))) });
  const t0 = Date.now();
  const reply = await d.ask(db, [{ ref, title: (item.title ?? "").slice(0, 300), fixes, files: shown, diff: diff.text, ...repoDir }], checkout, tool);
  log(`model call took ${Math.round((Date.now() - t0) / 1000)} s`);

  const offered = checkout !== undefined && CLAUDE_PROMPTS["fixup.patch"].sandbox?.check === true;
  log(`\ntools given to the model: ${offered ? `${[...CLAUDE_PROMPTS["fixup.patch"].sandbox!.tools, "Agent", "mcp__build__check"].join(", ")} (check offered; commands that returned a result: ${[...tool.ran].join(", ") || "none"})` : "none (no checkout, so no sandbox and no check tool)"}`);
  const runs = (await listRuns(db, { limit: 100 }, STAFF)).rows.filter((r) => r.id > before0 && r.promptId === "fixup.patch").sort((a, b) => a.id - b.id);
  for (const r of runs) log(`model call: agent run ${r.id}: ${r.summary ?? "no summary"}`);
  log("tool calls:");
  const calls = await loadModelChecksAfter(db, before, { step: "fixup", repo, number, head });
  if (!calls.length) log("  none");
  for (const c of calls) log(`  ${c.command}${c.crate ? ` -p ${c.crate}` : ""}${c.testName ? ` ${c.testName}` : ""}: ${c.outcome ?? "unfinished"} (task ${c.taskId ?? "none"}, ${c.endedAt ? Math.round((Date.parse(c.endedAt) - Date.parse(c.startedAt)) / 1000) : "?"} s)`);

  if (reply === null) { log("\nthe model gave no answer"); return 1; }
  const v = validatePatch(reply, files, (x) => fixupEditable(x, scripts));
  if (!v.ok) { log(`\nrefused: ${v.reason}\n\nreply:\n${indent(reply.slice(0, 3000))}`); return 1; }
  log(`\nfinal patch (${v.changed} changed lines):\n${indent(v.patch)}`);
  const applied = await applyCheck(git, d.root, head)(v.patch);
  if (applied) { log(`\nrefused: ${applied}`); return 1; }
  log("\napply: the patch applies to the head");

  let code = 0;
  if (v.patch.length > CHECK_PATCH_CAP) { log(`\nOpus check skipped: the patch is over the ${CHECK_PATCH_CAP} character limit`); return 1; }
  const checkReply = await d.check(db, [{ ref, title: (item.title ?? "").slice(0, 300), review_reason: review.reason ?? "", fixes, diff: diff.text.slice(0, CHECK_DIFF_CAP), patch: v.patch, ...repoDir }], checkout);
  const verdict = checkReply === null ? null : parseCheck(checkReply);
  if (!verdict) log("\nOpus check: no answer");
  else if (!verdict.ok) log(`\nOpus check: no valid answer: ${verdict.error}`);
  else { log(`\nOpus check: ${verdict.check.verdict}: ${checkLine(verdict.check)}`); if (verdict.check.verdict === "reject") code = 2; }

  const task = await queueLintFor(db, { step: "fixup", repo, number, head, base, patch: v.patch });
  if (task === null) { log("\nlint: the patch changes no .rs file; no lint task"); return code; }
  log(`\nlint task ${task} queued`);
  const l0 = Date.now();
  while (Date.now() - l0 < LINT_GIVE_UP_MS) {
    const t = (await loadTaskStates(db, [task])).get(task);
    if (!t || TERMINAL.includes(t.state)) break;
    await sleep(5000);
  }
  const res = await readLint(db, task);
  if (res.kind !== "result") { log(`lint: no result: ${res.kind === "pending" ? "still running" : res.reason}`); return 1; }
  log(`lint: ${res.findings.length} findings on the patch's lines`);
  for (const f of res.findings) log(indent(`${f.level} ${f.code ?? ""} ${f.file}:${f.line}\n${f.rendered}`));
  log(`lint: format changes: ${res.formatDiff ? `\n${indent(res.formatDiff)}` : "none"}`);
  return res.findings.length || res.formatDiff ? 2 : code;
}
