// Searching existing issues: the message command "Find issue", and a small search form (one text box, no app and no
// follow-up questions) that the panel's "Find an existing issue" button and `/autocraft search` open. Both run the same
// search. Replies are visible to the caller only; the "File a new issue" button of the results opens the full form
// (issue-new.ts), which `/autocraft report` opens too.
import type { Call, Interactions } from "./interactions.ts";
import type { DiscordKeys } from "./keys.ts";
import { deliver, renderMatches } from "./reply.ts";
import { QUESTION_CHARS, type Search } from "./search.ts";
import type { Db } from "../db/index.ts";

export const FIND_ISSUE = "Find issue";
const FORM = "ifind";

/** Shows the search form; it must be the first response to the interaction. */
export async function showSearchForm(call: Call): Promise<void> {
  await call.showModal({
    custom_id: `${FORM}:form`, title: "Find an existing issue",
    components: [{ type: 18, label: "Search", component: { type: 4, custom_id: "q", style: 1, required: true, max_length: QUESTION_CHARS, placeholder: "A few words about the problem or idea" } }],
  });
}

export function installSearchCommands(ix: Interactions, deps: { db: Db; keys: DiscordKeys; search: Search }): void {
  const { db, keys, search } = deps;
  const run = async (call: Call, text: string | undefined): Promise<void> => {
    const question = (text ?? "").replace(/\s+/g, " ").trim().slice(0, QUESTION_CHARS);
    if (!question) return void (await call.edit({ content: "There is no text to search with." }));
    const i = call.interaction;
    if (!search.allow(keys.hash("author", call.userId ?? "?"), keys.hash("channel", i.channel_id ?? "?"))) return void (await call.edit({ content: "Too many searches just now. Try again in a minute." }));
    const found = await search.find(question);
    const r = await renderMatches(db, found.matches, question, i.channel_id);
    await deliver(r, (b) => call.edit(b));
  };
  ix.command("autocraft search", { name: "autocraft", type: 1, description: "AutoCraft", dm_permission: false, options: [{ type: 1, name: "search", description: "Find existing issues" }] }, showSearchForm, { immediate: true });
  ix.component(FORM, (call) => run(call, call.fields().q));
  ix.command(FIND_ISSUE, { name: FIND_ISSUE, type: 3, dm_permission: false }, (call) => run(call, call.targetText()));
}
