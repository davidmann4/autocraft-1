// autocraft-server conversation show|say|do: the operator's conversation actions from the shell.
import { parseRef } from "../classify/parse.ts";
import { getAccess } from "../access.ts";
import { doCard } from "./act.ts";
import { githubDiff, runConversations } from "./run.ts";
import { loadThreads } from "../data/conversations/index.ts";
import { ConversationError, addMessage } from "./store.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";

const USAGE = "usage: autocraft-server conversation show <repo>#<n> | say <repo>#<n> <text> [--by LOGIN] [--now] | do <card-id> --by LOGIN";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Only operators write in conversations and run cards; the shell takes the login on trust but not the role. */
async function needOperator(db: Db, by: string): Promise<void> {
  if ((await getAccess(db, by))?.role !== "operator") throw new ConversationError(1, `${by} is not an operator`);
}

export const commands = {
  conversation: {
    summary: "conversation show <repo>#<n> | say <repo>#<n> <text> [--by LOGIN] [--now] | do <card-id> --by LOGIN: read, write in, or run a card of an item's Opus conversation",
    async run(args: string[]): Promise<void> {
      const [sub, target] = args;
      const db = await openDb();
      try {
        if (sub === "do") {
          const by = flag(args, "--by"), id = Number(target);
          if (!Number.isInteger(id) || !by) throw new ConversationError(2, USAGE);
          await needOperator(db, by);
          const r = await doCard(db, id, by, { via: "cli" });
          console.log(r.ran ? `card ${id}: ${r.card.state}${r.card.error ? `: ${r.card.error}` : ""}${r.card.result_url ? ` ${r.card.result_url}` : ""}` : `card ${id} is already ${r.card.state}; nothing done`);
          return;
        }
        const ref = parseRef(target ?? "");
        if (!ref || (sub !== "show" && sub !== "say")) throw new ConversationError(2, USAGE);
        if (sub === "say") {
          const by = flag(args, "--by");
          if (!by) throw new ConversationError(2, USAGE);
          await needOperator(db, by);
          const text = args.slice(2).filter((a, i, all) => a !== "--now" && a !== "--by" && all[i - 1] !== "--by").join(" ");
          await addMessage(db, ref.repo, ref.number, { login: by, kind: "operator" }, text, { diff: githubDiff(db) });
          console.log(`${ref.repo}#${ref.number}: message queued; the Conversation step answers it`);
          if (args.includes("--now")) {
            // The same gates as the autopilot: the pipeline switch and the step's daily limit.
            const { isEnabled, pauseReason } = await import("../runner/autopilot.ts");
            const why = !await isEnabled(db) ? "the pipeline is off" : await pauseReason(db, "conversation", Date.now(), { backoff: false });
            if (why) console.log(`not answered now: ${why}`);
            else console.log(`${(await runConversations(db, { kind: "operator", limit: 1 })).answered} answered`);
          }
        }
        const thread = (await loadThreads(db, [`${ref.repo}#${ref.number}`])).get(`${ref.repo}#${ref.number}`);
        for (const t of thread?.turns ?? []) {
          console.log(`\n[${t.id}] ${t.login} ${t.at}${t.status ? ` (${t.status})` : ""}\n${t.body}`);
          for (const c of thread!.cards.filter((x) => x.turn_id === t.id)) {
            console.log(`  card ${c.id} [${c.state}] ${c.description}${c.text ? `\n    ${c.text.replace(/\n/g, "\n    ")}` : ""}`);
          }
        }
      } catch (e) {
        if (!(e instanceof ConversationError)) throw e;
        console.error(e.message);
        process.exit(e.status === 2 ? 2 : 1);
      }
    },
  },
};
