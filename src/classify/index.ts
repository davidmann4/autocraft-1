// autocraft-server classify | classify current | classify-sample | classify-referee | classify-compare
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { band, compareReport, itemUrl, loadReference, loadRows, pairUp, ref, type Pair } from "./report.ts";
import { markSpotCheck, pickDisagreements, runReferee } from "./referee.ts";
import { loadOpenNumbers } from "../data/mirror/index.ts";
import { loadUsageByModel } from "../data/inference/index.ts";
import { classifyRunInfo, countVerdicts, loadRunRows, runHasVerdicts, setClassifyRun } from "../data/triage/index.ts";
import { loadItems, loadRefs, runHaiku, runJev } from "./run.ts";
import { rng, shuffle } from "./sample.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";

function flags(args: string[], names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const n = args[i]?.replace(/^--/, "");
    if (!n || !names.includes(n) || args[i + 1] === undefined) {
      console.error(`unknown or incomplete option ${args[i]}; options: ${names.map((x) => "--" + x).join(" ")}`);
      process.exit(1);
    }
    out[n] = args[i + 1]!;
  }
  return out;
}

function need(f: Record<string, string>, name: string): string {
  if (!f[name]) {
    console.error(`missing --${name}`);
    process.exit(1);
  }
  return f[name]!;
}

// autocraft-server classify current [<run>]: shows the current run, or makes <run> the current one.
async function current(args: string[]): Promise<void> {
  const db = await openDb();
  const [run] = args;
  if (args.length > 1) {
    console.error("usage: classify current [<run>]");
    process.exit(1);
  }
  if (run === undefined) {
    const { set, derived } = await classifyRunInfo(db);
    console.log(set ? `current run: ${set}` : `no current run is set; the run with the newest Jev (or Haiku-alone) verdict is used: ${derived ?? "none"}`);
    return;
  }
  if (!await runHasVerdicts(db, run)) {
    console.error(`run ${run} has no Jev or Haiku-alone verdicts`);
    process.exit(1);
  }
  await setClassifyRun(db, run, "cli");
  console.log(`current run: ${run}`);
}

async function classify(args: string[]): Promise<void> {
  if (args[0] === "current") return await current(args.slice(1));
  const f = flags(args, ["classifier", "run-id", "items"]);
  const which = need(f, "classifier"), runId = need(f, "run-id");
  if (which !== "jev" && which !== "haiku") {
    console.error("--classifier is jev or haiku");
    process.exit(1);
  }
  const db = await openDb();
  const items = await loadItems(db, loadRefs(need(f, "items")));
  const t0 = Date.now();
  if (which === "jev") await runJev(db, runId, items);
  else await runHaiku(db, runId, items);
  const n = await countVerdicts(db, { run: runId, classifier: which });
  console.log(`${which}: ${n}/${items.length} items classified in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

/** Open PRs that have a reference label, plus open issues of the named repos, chosen with a fixed seed. */
async function sample(args: string[]): Promise<void> {
  const f = flags(args, ["seed", "reference", "pr-repo", "prs", "issue-repos", "issues-each", "out-dir"]);
  const seed = Number(f.seed ?? 1), rand = rng(seed);
  const db = await openDb();
  const outDir = need(f, "out-dir");
  const prRepo = need(f, "pr-repo");
  const reference = loadReference(need(f, "reference"), prRepo);
  const open = async (repo: string, kind: "pr" | "issue") => (await loadOpenNumbers(db, [repo], kind)).get(repo) ?? [];
  const prs = (await open(prRepo, "pr")).map((n) => `${prRepo}#${n}`).filter((r) => reference.has(r));
  const a = shuffle(prs, rand).slice(0, Number(f.prs ?? 200)).sort();
  const b: string[] = [];
  for (const repo of (f["issue-repos"] ?? "").split(",").filter(Boolean)) {
    const issues = (await open(repo, "issue")).map((n) => `${repo}#${n}`);
    b.push(...shuffle(issues, rand).slice(0, Number(f["issues-each"] ?? 50)).sort());
  }
  writeFileSync(join(outDir, "items-a.txt"), a.join("\n") + "\n");
  writeFileSync(join(outDir, "items-b.txt"), b.join("\n") + "\n");
  writeFileSync(join(outDir, "items-all.txt"), [...a, ...b].join("\n") + "\n");
  console.log(`${prs.length} open PRs with a reference label; sampled ${a.length} PRs and ${b.length} issues into ${outDir}`);
}

async function pairsOf(db: Db, runId: string, refFile: string | undefined, prRepo: string): Promise<Pair[]> {
  return pairUp(await loadRows(db, runId), refFile ? loadReference(refFile, prRepo) : new Map());
}

async function referee(args: string[]): Promise<void> {
  const f = flags(args, ["run-id", "reference", "pr-repo", "count", "spot-check", "seed"]);
  const runId = need(f, "run-id"), seed = Number(f.seed ?? 1);
  const db = await openDb();
  const pairs = await pairsOf(db, runId, f.reference, f["pr-repo"] ?? "photocraft");
  const picked = pickDisagreements(pairs, Number(f.count ?? 30), seed);
  await runReferee(db, runId, picked);
  await markSpotCheck(db, runId, pairs, Number(f["spot-check"] ?? 10), seed);
  console.log(`refereed ${picked.length} of ${pairs.filter((p) => p.jev.type_label !== p.haiku.type_label).length} disagreements`);
}

async function costSection(db: Db, runId: string, pairs: Pair[]): Promise<string> {
  const rows = await loadUsageByModel(db, runId);
  const n = pairs.length;
  const head = ["Model", "Calls", "Items", "Input", "Output", "Cache read", "Cache write", "USD", "Wall time", "Summed call time", "Per 100 items (in / out / USD)"];
  const body = rows.map((r) => {
    const per = r.items ? 100 / r.items : 0;
    return [r.model, r.calls, r.items, r.input, r.output, r.cacheRead, r.cacheWrite, r.costUsd === null ? "-" : r.costUsd.toFixed(2),
      `${r.wallSeconds.toFixed(0)} s`, `${r.busySeconds.toFixed(0)} s`, `${(r.input * per).toFixed(0)} / ${(r.output * per).toFixed(0)} / ${r.costUsd === null ? "-" : (r.costUsd * per).toFixed(2)}`];
  });
  return `Items in the comparison: ${n}. Jev usage is the \`usage\` object it returns (input_tokens, output_tokens); its cost is the input tokens at TypeSafe's published price (output tokens are free). Wall time is first start to last end of that model's calls (calls run in parallel: Jev 8, Haiku 4, Sonnet 3).\n\n` +
    `| ${head.join(" | ")} |\n|${head.map(() => "---").join("|")}|\n${body.map((r) => `| ${r.join(" | ")} |`).join("\n")}`;
}

async function refereeSection(db: Db, runId: string, pairs: Pair[]): Promise<{ text: string; spot: string; stats: { n: number; jev: number; haiku: number; neither: number } }> {
  const sonnet = new Map((await loadRunRows(db, runId)).filter((r) => r.classifier === "sonnet").map((r) => [ref(r), r]));
  const ps = pairs.filter((p) => sonnet.has(ref(p.r)));
  const side = (p: Pair) => { const v = sonnet.get(ref(p.r))!.type_label ?? ""; return v === p.jev.type_label ? "jev" : v === p.haiku.type_label ? "haiku" : "neither"; };
  const stats = { n: ps.length, jev: ps.filter((p) => side(p) === "jev").length, haiku: ps.filter((p) => side(p) === "haiku").length, neither: ps.filter((p) => side(p) === "neither").length };
  const by = (k: string) => ps.filter((p) => p.r.kind === k);
  const text = ps.length === 0 ? "No refereed items." : `Sonnet judged ${stats.n} disagreements, without seeing either answer.\n\n| Group | Items | Sonnet sides with Jev | with Haiku | with neither |\n|---|---|---|---|---|\n` +
    [["all", ps], ["PRs", by("pr")], ["issues", by("issue")]].map(([name, g]) => { const x = g as Pair[]; return `| ${name} | ${x.length} | ${x.filter((p) => side(p) === "jev").length} | ${x.filter((p) => side(p) === "haiku").length} | ${x.filter((p) => side(p) === "neither").length} |`; }).join("\n");
  const spot = ps.filter((p) => sonnet.get(ref(p.r))!.flags?.includes("spot-check")).map((p, i) => {
    const s = sonnet.get(ref(p.r))!;
    const pj = p.jev.top === null ? "" : ` (${p.jev.top.toFixed(2)})`;
    return `${i + 1}. [${ref(p.r)}](${itemUrl(p.r)}) ${p.r.title}\n   - Jev: ${p.jev.type_label}${pj}; Haiku: ${p.haiku.type_label}; reference: ${p.ref ?? "none"}\n   - Referee: ${s.type_label} (sides with ${side(p)}): ${s.reason}`;
  }).join("\n");
  return { text, spot, stats };
}

async function compare(args: string[]): Promise<void> {
  const f = flags(args, ["run-id", "reference", "pr-repo", "out"]);
  const runId = need(f, "run-id");
  const db = await openDb();
  const pairs = await pairsOf(db, runId, f.reference, f["pr-repo"] ?? "photocraft");
  const r = await refereeSection(db, runId, pairs);
  const conf = pairs.filter((p) => p.ref && band(p.jev.top) === "≥0.9");
  const confOk = conf.filter((p) => p.jev.type_label === p.ref).length;
  const rule = `Rule inputs: Jev on confident items (top probability ≥0.9) with a reference: ${confOk}/${conf.length} = ${conf.length ? ((100 * confOk) / conf.length).toFixed(1) : "-"}% (needs ≥90%). ` +
    `In ${r.stats.n} refereed disagreements Jev was wrong ${r.stats.n - r.stats.jev} times and Haiku ${r.stats.n - r.stats.haiku} times.`;
  const report = [`# Classification pilot ${runId}`, "", compareReport(pairs), "", "## Referee", "", r.text, "", "## Spot-check items", "", r.spot, "", "## Cost", "", await costSection(db, runId, pairs), "", "## Rule", "", rule, ""].join("\n");
  if (f.out) writeFileSync(f.out, report);
  else console.log(report);
}

export const commands = {
  classify: { summary: "classify --classifier jev|haiku --run-id <id> --items <file> | classify current [<run>]", run: classify },
  "classify-sample": { summary: "classify-sample --reference <csv> --pr-repo <r> --issue-repos a,b --out-dir <dir> [--seed --prs --issues-each]", run: sample },
  "classify-referee": { summary: "classify-referee --run-id <id> [--reference <csv> --count 30 --spot-check 10 --seed 1]", run: referee },
  "classify-compare": { summary: "classify-compare --run-id <id> [--reference <csv> --out <file>]", run: compare },
};
