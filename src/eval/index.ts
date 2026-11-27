// CLI of the self-evaluation: `autocraft-server eval repo [<name> | --clear]`, `eval run [--dry [--investigate] [--text]]` and `eval status`.
// Operator only: the box's shell is the operator's.
import { loadEvalCauses } from "../data/eval/index.ts";
import { openDb } from "../db/open.ts";
import { evalRepo, setEvalRepo } from "./schedule.ts";

const USAGE = "eval repo [<name> | --clear] | eval run [--dry [--investigate] [--text]] | eval status";
const DRY_FLAGS = new Set(["--dry", "--investigate", "--text"]);

export const commands = {
  eval: {
    summary: `${USAGE}: the hourly self-evaluation and the repo it files issues on`,
    async run(args: string[]): Promise<void> {
      const [sub, ...rest] = args;
      const db = await openDb();
      if (sub === "repo") {
        if (rest.length > 1) throw new Error(`usage: autocraft-server ${USAGE}`);
        if (rest[0] !== undefined) await setEvalRepo(db, rest[0] === "--clear" ? null : rest[0], "cli");
        console.log(`eval_repo ${await evalRepo(db) ?? "(off)"}`);
      } else if (sub === "run" && rest.includes("--dry") && rest.every((a) => DRY_FLAGS.has(a))) {
        // What a run would do, inline, posting nothing and leaving the causes as they are. Only --investigate fetches the
        // checkout and calls the model, which writes the calls' own rows.
        const { dryRunEval } = await import("./run.ts");
        await dryRunEval(db, { repo: await evalRepo(db), investigate: rest.includes("--investigate"), text: rest.includes("--text") });
      } else if (sub === "run" && !rest.length) {
        // A real run goes through the job queue, so it never overlaps the hourly job (one live job per step and repo).
        const repo = await evalRepo(db);
        if (!repo) throw new Error("no eval repo is set: autocraft-server eval repo <name>");
        const { CLI_QUEUE_BY, enqueue, JobError } = await import("../runner/jobs.ts");
        try {
          console.log(`job ${(await enqueue(db, "eval", { repo }, CLI_QUEUE_BY)).id} queued; the runner runs it (autocraft-server eval status shows the causes)`);
        } catch (e) {
          if (e instanceof JobError) throw new Error(`not queued: ${e.message}`);
          throw e;
        }
      } else if (sub === "status" && !rest.length) {
        for (const c of [...(await loadEvalCauses(db)).values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))) {
          console.log(`${c.key}  ${c.state}${c.verdict ? ` ${c.verdict}` : ""}${c.issueNumber ? ` issue ${c.issueNumber}` : ""}  seen ${c.seen}  last ${c.lastSeen.slice(0, 16)}`);
        }
      } else throw new Error(`usage: autocraft-server ${USAGE}`);
    },
  },
};
