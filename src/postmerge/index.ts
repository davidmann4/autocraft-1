// CLI of the post-merge review stage: `autocraft-server postmerge review <repo>#<n> [--again]`,
// `autocraft-server postmerge file <repo>#<n> <finding>` and `autocraft-server postmerge backfill --since <ISO date> [--yes]`.
// Operator only: the box's shell is the operator's.
import { addAudit } from "../data/control/index.ts";
import { isRunning } from "../data/jobs/index.ts";
import { loadPostmerge } from "../data/review/index.ts";
import { mergedPr } from "./select.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";

const ACTOR = "cli";
const USAGE = "postmerge review <repo>#<n> [--again] | postmerge file <repo>#<n> <finding> | postmerge backfill --since <ISO date> [--yes]";

/** Reviews one merged PR now; refuses a PR the pipeline did not merge, and one that has a review unless `again`. */
export async function reviewOne(db: Db, ref: string, again: boolean, log: (line: string) => void = console.log): Promise<void> {
  const m = /^([A-Za-z0-9._-]+)#([1-9][0-9]*)$/.exec(ref);
  if (!m) throw new Error(`not a repo#number: ${ref}`);
  const repo = m[1]!, number = Number(m[2]);
  if (!await mergedPr(db, repo, number)) throw new Error(`${ref} was not merged by the pipeline`);
  if (!again && (await loadPostmerge(db, [{ repo, number }])).get(ref)?.error === null) throw new Error(`${ref} has a post-merge review; add --again to review it again`);
  // The runner's job reviews any candidate of its repo; two reviews of one PR at once would replace each other's rows.
  if ((await isRunning(db, [{ step: "postmerge", repo }])).size) throw new Error(`a postmerge job is running for ${repo}; try again when it has finished`);
  await addAudit(db, [{ login: ACTOR, action: "postmerge-review", target: ref, details: { again } }]);
  const { runPostmerge } = await import("./review.ts");
  await runPostmerge(db, { repo, only: [number] }, log);
}

export const commands = {
  postmerge: {
    summary: `${USAGE}: post-merge review of pipeline merges`,
    async run(args: string[]): Promise<void> {
      const [sub, ...rest] = args;
      if (sub === "review") {
        const again = rest.includes("--again");
        const refs = rest.filter((a) => a !== "--again");
        if (refs.length !== 1 || refs[0]!.startsWith("--")) throw new Error(`usage: autocraft ${USAGE}`);
        await reviewOne(await openDb(), refs[0]!, again);
      } else if (sub === "file") {
        const idx = Number(rest[1]);
        if (rest.length !== 2 || !Number.isInteger(idx) || idx < 0) throw new Error(`usage: autocraft ${USAGE}`);
        const { fileFinding } = await import("./file.ts");
        await fileFinding(await openDb(), rest[0]!, idx);
      } else if (sub === "backfill") {
        const yes = rest.includes("--yes");
        const a = rest.filter((x) => x !== "--yes");
        if (a[0] !== "--since" || a.length !== 2 || Number.isNaN(Date.parse(a[1]!))) throw new Error("usage: autocraft-server postmerge backfill --since <ISO date> [--yes]");
        const { queueBackfill } = await import("./review.ts");
        const n = await queueBackfill(await openDb(), ACTOR, a[1]!, { yes });
        console.log(`${n} merged PRs wait for a post-merge review; the postmerge step reviews them`);
      } else throw new Error(`usage: autocraft ${USAGE}`);
    },
  },
};
