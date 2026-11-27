// `autocraft-server embed`: embed new and changed tracked items for similar items and
// semantic search.
import { refreshSnapshot } from "../itemtools/snapshot.ts";
import { localEmbedder, modelCacheDir, modelName } from "./model.ts";
import { embedItems } from "./store.ts";
import { envVar } from "../env.ts";
import { openDb } from "../db/open.ts";

const USAGE = "usage: autocraft-server embed [--all] [--threads N] [--batch N]";
const MAX_THREADS = 8;

function intArg(args: string[], flag: string, def: number): number {
  const i = args.indexOf(flag);
  if (i < 0) return def;
  const n = Number(args[i + 1]);
  if (!Number.isInteger(n) || n < 1) {
    console.error(USAGE);
    process.exit(1);
  }
  return n;
}

// The item snapshot carries the vectors. A pipeline job leaves its refresh to the runner leader's keeper
// (src/itemtools/keeper.ts), which builds after each embed job ends; a run from the command line refreshes it here.
async function embed(args: string[]): Promise<void> {
  if (await embedCommand(args)) await refreshSnapshot();
}

/** The embed command; `onEmbedded` gets the running count of items embedded. Returns the total. Does not refresh the item snapshot. */
export async function embedCommand(args: string[], onEmbedded?: (n: number) => void): Promise<number> {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--threads" || args[i] === "--batch") i++;
    else if (args[i] !== "--all") {
      console.error(USAGE);
      process.exit(1);
    }
  }
  const threads = Math.min(intArg(args, "--threads", Number(envVar("EMBED_THREADS")) || MAX_THREADS), MAX_THREADS);
  const batch = intArg(args, "--batch", 32);
  const db = await openDb();
  const embedder = localEmbedder({ name: modelName(), threads });
  console.error(`model ${embedder.id}, ${threads} threads, cache ${modelCacheDir()}`);
  let last = 0;
  const r = await embedItems(db, embedder, {
    all: args.includes("--all"),
    batch,
    onProgress: ({ done, total, ms }) => {
      onEmbedded?.(done);
      if (done < total && ms - last < 10_000) return;
      last = ms;
      const rate = done / (ms / 1000);
      const left = (total - done) / rate;
      console.error(`${done}/${total} items, ${rate.toFixed(1)}/s${done < total ? `, about ${Math.ceil(left / 60)} min left` : ""}`);
    },
  });
  await db.close();
  console.log(`embedded ${r.embedded} items, removed ${r.pruned} stale vectors, ${(r.ms / 1000).toFixed(1)} s`);
  return r.embedded;
}

export const commands = {
  embed: { summary: "embed new and changed items for similar items and semantic search", run: embed },
};
