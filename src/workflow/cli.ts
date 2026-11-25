// `workflow flip <repo> [--dry-run] [--legacy]` and `workflow status [repo]`.
import { openDb } from "../db/open.ts";
import { FlipRefused, flipLines, flipRepo } from "./flip.ts";
import { liveWorkflows, repoWorkflows } from "./store.ts";

const USAGE = "usage: workflow flip <repo> [--dry-run] [--legacy] | workflow status [repo]";

async function status(repo: string | undefined): Promise<void> {
  const db = await openDb();
  const live = await liveWorkflows(db, repo);
  const repos = (await repoWorkflows(db)).filter((r) => !repo || r.repo === repo);
  if (repo && !repos.length) throw new FlipRefused(`${repo} is not tracked`);
  for (const r of repos) {
    const mine = live.filter((w) => w.repo === r.repo);
    if (!repo && r.workflow === "legacy" && !mine.length) continue;
    console.log(`${r.repo}: ${r.workflow}, ${mine.length} live workflow${mine.length === 1 ? "" : "s"}`);
    if (!repo) continue;
    for (const w of mine) {
      const approved = w.approvedBy ? `approved by ${w.approvedBy}` : "not approved";
      const blocker = w.blocker ? `, blocker ${w.blocker}` : "";
      console.log(`  #${w.number} ${w.kind} entry ${w.entry} ${w.state} weight ${w.weight}, started by ${w.startedBy}, ${approved}${blocker}`);
    }
  }
  if (!repo && !repos.some((r) => r.workflow === "new") && !live.length) console.log("every tracked repo runs legacy");
}

export const commands = {
  workflow: {
    summary: "workflow flip <repo> [--dry-run] [--legacy] | status [repo]: move a repo to the maintainer workflow (its open Merge?, Hold and scope questions withdrawn, its PR status comment, merging and pushing approved) or back, or list it",
    async run(args: string[]): Promise<void> {
      const [sub, ...rest] = args;
      try {
        if (sub === "status" && rest.length <= 1) return await status(rest[0]);
        const repo = rest.find((a) => !a.startsWith("--"));
        const flags = rest.filter((a) => a.startsWith("--"));
        if (sub !== "flip" || !repo || rest.length - flags.length !== 1 || flags.some((f) => f !== "--dry-run" && f !== "--legacy")) throw new FlipRefused(USAGE);
        const db = await openDb();
        const r = await flipRepo(db, repo, { to: flags.includes("--legacy") ? "legacy" : "new", by: "cli", apply: !flags.includes("--dry-run") });
        for (const line of flipLines(r)) console.log(line);
        if (r.refused) process.exit(1);
      } catch (e) {
        if (!(e instanceof FlipRefused)) throw e;
        console.error(e.message);
        process.exit(1);
      }
    },
  },
};
