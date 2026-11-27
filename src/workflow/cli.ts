// `workflow status [repo]`: the live workflows, per tracked repo; with a repo, each one's queued jobs and model calls and what holds each back. `workflow auto-stops [repo]`: the workflows the next workflow pass
// starts for PRs the automatic merge rule stopped for a person (auto-stop.ts), by wait code; it writes nothing.
import { loadTrackedRepos, readConfig, SETTINGS } from "../data/control/index.ts";
import { listWorkflows } from "../data/workflow/index.ts";
import { openDb } from "../db/open.ts";
import { findAutoStops } from "./auto-stop.ts";
import { notPostedLines } from "./waits.ts";
import { queuedOfItems } from "../runner/why-queued.ts";

const USAGE = "usage: workflow status [repo] | workflow auto-stops [repo]";

async function status(repo: string | undefined): Promise<void> {
  const db = await openDb();
  const [tracked, live] = await db.together(() => Promise.all([loadTrackedRepos(db), listWorkflows(db, { live: true, ...(repo ? { repos: [repo] } : {}) })]));
  const repos = [...tracked.keys()].filter((r) => !repo || r === repo).sort();
  if (repo && !repos.length) throw new Error(`${repo} is not tracked`);
  for (const r of repos) {
    const mine = live.filter((w) => w.repo === r);
    if (!repo && !mine.length) continue;
    console.log(`${r}: ${mine.length} live workflow${mine.length === 1 ? "" : "s"}`);
    if (!repo) continue;
    const [unposted, queued] = await Promise.all([notPostedLines(db, mine), queuedOfItems(db, mine, { shown: true })]);
    for (const w of mine) {
      const approved = w.approvedBy ? `approved by ${w.approvedBy}` : "not approved";
      const blocker = w.blocker ? `, blocker ${w.blocker}` : "";
      console.log(`  #${w.number} ${w.kind} entry ${w.entry} ${w.state} weight ${w.weight}, started by ${w.startedBy}, ${approved}${blocker}`);
      const notPosted = unposted.get(w.id);
      if (notPosted) console.log(`    ${notPosted}`);
      for (const q of queued.get(`${w.repo}#${w.number}`) ?? []) console.log(`    queued ${q.kind} ${q.id} (${q.title})${q.why ? `: ${q.why}` : ""}`);
    }
  }
  if (!repo && !live.length) console.log("no live workflows");
}

async function autoStops(repo: string | undefined): Promise<void> {
  const db = await openDb();
  const stops = await findAutoStops(db, repo ? { repos: [repo] } : {});
  if (!(await readConfig(db, [SETTINGS.pipelineEnabled.name])).pipelineEnabled) console.log("the pipeline is off: no pass starts these until it is on");
  const byCode = new Map<string, string[]>();
  for (const s of stops) byCode.set(s.code, [...byCode.get(s.code) ?? [], `${s.repo}#${s.number}`]);
  console.log(`${stops.length} workflow${stops.length === 1 ? "" : "s"} the next pass would start`);
  for (const [code, refs] of [...byCode].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${code}: ${refs.length} (${refs.join(" ")})`);
}

export const commands = {
  workflow: {
    summary: "workflow status [repo]: the live workflows of each tracked repo; workflow auto-stops [repo]: what the next pass starts for the automatic merge rule's stops, read only",
    async run(args: string[]): Promise<void> {
      const [sub, ...rest] = args;
      if ((sub !== "status" && sub !== "auto-stops") || rest.length > 1) {
        console.error(USAGE);
        process.exit(1);
      }
      try {
        await (sub === "status" ? status : autoStops)(rest[0]);
      } catch (e) {
        console.error((e as Error).message);
        process.exit(1);
      }
    },
  },
};
