// The holds of merge-queue controls: hold an item, resume it, take a PR out of its batch (which holds it), stop a batch (which holds its
// PRs). Each is the command `hold` or `resume` on the items, then the end of the batch.
//
//   autocraft-server hold <repo#n>             autocraft-server resume <repo#n>
//   autocraft-server batch-remove <repo#n>     autocraft-server batch-stop <id>
import type { Exec } from "../fixup/git.ts";
import { exec as defaultExec } from "../fixup/git.ts";
import { loadItems } from "../data/mirror/index.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";
import { activeBatch, batchOf, ControlError, endStoppedBatch, removeFromBatch } from "../merge/controls.ts";
import { ownerOf } from "../owners.ts";
import { inActiveBatch } from "../preapproval/index.ts";
import { runCommand, type Actor, type ItemOutcome } from "./apply.ts";
import { saying } from "./said.ts";
import { endLeg } from "./effects.ts";
import type { Parsed, Surface } from "./types.ts";

const refOf = (repo: string, number: number): string => `${repo}#${number}`;
const command = (word: "hold" | "resume"): Parsed => ({ kind: "commands", items: [], parts: [{ word }] });

const isHeld = (o: ItemOutcome): boolean => o.outcome === "run" || o.refusal === "already-held";

/** Sends the word to one item; a refusal is thrown, but for the ones `passes` takes. */
async function sendTo(db: Db, actor: Actor, via: Surface, word: "hold" | "resume", repo: string, number: number, run: Exec | undefined, passes: (o: ItemOutcome) => boolean): Promise<ItemOutcome> {
  const r = await (via === "cli" && actor.login
    ? saying(db, { login: actor.login, via: "cli", text: word, items: [{ repo, number }], by: null }, () => runCommand(db, actor, via, { parsed: command(word), items: [{ repo, number }], ...(run ? { exec: run } : {}) }))
    : runCommand(db, actor, via, { parsed: command(word), items: [{ repo, number }], ...(run ? { exec: run } : {}) }));
  const o = r.items[0];
  if (!o || !passes(o)) throw new ControlError(r.lines.join(" "));
  return o;
}

/** Holds (or resumes) one item; a refusal is thrown. */
export const holdItem = (db: Db, actor: Actor, via: Surface, word: "hold" | "resume", repo: string, number: number, run?: Exec): Promise<ItemOutcome> =>
  sendTo(db, actor, via, word, repo, number, run, (o) => o.outcome === "run");

/**
 * Holds the PR, which ends its batch: the others go back to the queue and the next merge run builds a batch without it. Throws when the batch
 * could not be ended; sent again, it ends the batch of a PR that is held already.
 */
export async function holdBatched(db: Db, actor: Actor, via: Surface, repo: string, number: number, run?: Exec): Promise<{ batch: string; line: string }> {
  const b = await batchOf(db, repo, number);
  const o = await sendTo(db, actor, via, "hold", repo, number, run, isHeld);
  if (await inActiveBatch(db, repo, number)) {
    if (o.outcome === "run") throw new ControlError(o.line, 502);
    await removeFromBatch(db, actor.login ?? "", repo, number, run);
  }
  return { batch: b.branch, line: o.line };
}

/**
 * Stops the batch: holds its open PRs, so the next merge run does not rebuild it, closes its integration PR, then ends their merge legs.
 * They are resumed one by one. Sent again after the close failed, it ends the batch of PRs that are held already.
 */
export async function stopBatch(db: Db, actor: Actor, via: Surface, id: number, run: Exec = defaultExec): Promise<{ batch: string; prs: number[]; held: number[]; closed: number | null }> {
  const b = await activeBatch(db, id);
  const by = actor.login ?? "";
  const prs = b.members.map((m) => m.number);
  const items = await loadItems(db, prs.map((number) => ({ repo: b.repo, number })), "ref");
  const open = prs.filter((n) => items.get(refOf(b.repo, n))?.state === "OPEN");
  let held: number[] = [];
  if (open.length) {
    const r = await runCommand(db, actor, via, { parsed: command("hold"), items: open.map((number) => ({ repo: b.repo, number })), exec: run, keepBatch: true });
    held = r.items.filter(isHeld).map((o) => o.number);
    if (!held.length) throw new ControlError(r.lines.join(" "));
  }
  const { closed } = await endStoppedBatch(db, by, b, prs, run);
  // A leg that can't be ended now cannot merge either (its workflow ended), and the pre-approval pass ends it.
  for (const n of held) await endLeg({ db, by, via, at: new Date().toISOString(), item: { repo: b.repo, number: n, kind: "pr", head: null }, exec: run }, { repo: b.repo, number: n }).catch(() => {});
  return { batch: b.branch, prs, held, closed };
}

/** `repo#number`, `owner/repo#number` or a GitHub URL of a tracked repo's item. */
function parseRef(text: string | undefined): { repo: string; number: number } {
  const t = text?.trim() ?? "";
  const m = /^https?:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/(?:pull|issues)\/([1-9][0-9]*)(?:[/?#].*)?$/.exec(t)
    ?? /^(?:([A-Za-z0-9._-]+)\/)?([A-Za-z0-9._-]+)#([1-9][0-9]*)$/.exec(t);
  if (!m) throw new ControlError("not an item: use a GitHub URL, repo#number or owner/repo#number", 400);
  if (m[1] && m[1].toLowerCase() !== ownerOf(m[2]!).toLowerCase()) throw new ControlError(`${m[1]}/${m[2]} is not a tracked repo of ${m[1]}`, 400);
  return { repo: m[2]!, number: Number(m[3]) };
}

async function cli(f: () => Promise<string>): Promise<void> {
  try {
    console.log(await f());
  } catch (e) {
    if (!(e instanceof ControlError)) throw e;
    console.error(e.message);
    process.exit(1);
  }
}

/** The box's own commands need no login. */
const BOX: Actor = { login: "cli", canWrite: async () => true };

export const commands = {
  hold: {
    summary: "hold <repo#n>: end all work on an item and keep off it until it is resumed (writes to GitHub when it is in a batch)",
    run: (args: string[]) => cli(async () => {
      const r = parseRef(args[0]);
      return `${refOf(r.repo, r.number)}: ${(await holdItem(await openDb(), BOX, "cli", "hold", r.repo, r.number)).line}`;
    }),
  },
  resume: {
    summary: "resume <repo#n>: go on with a held item",
    run: (args: string[]) => cli(async () => {
      const r = parseRef(args[0]);
      return `${refOf(r.repo, r.number)}: ${(await holdItem(await openDb(), BOX, "cli", "resume", r.repo, r.number)).line}`;
    }),
  },
  "batch-remove": {
    summary: "batch-remove <repo#n>: hold a PR and close its integration batch PR; the others are rebuilt in a new batch (writes to GitHub)",
    run: (args: string[]) => cli(async () => {
      const r = parseRef(args[0]);
      const out = await holdBatched(await openDb(), BOX, "cli", r.repo, r.number);
      return `${refOf(r.repo, r.number)}: removed from ${out.batch}. ${out.line}`;
    }),
  },
  "batch-stop": {
    summary: "batch-stop <id>: hold a batch's PRs and close its integration PR (writes to GitHub)",
    run: (args: string[]) => cli(async () => {
      const out = await stopBatch(await openDb(), BOX, "cli", Number(args[0]));
      return `${out.batch}: stopped${out.closed ? `; closed batch PR #${out.closed}` : ""}; held ${out.held.length ? out.held.map((n) => `#${n}`).join(", ") : "no PRs"} (resume to go on with them)`;
    }),
  },
};
