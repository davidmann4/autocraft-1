// Optional Discord mention counting, ping replies and issue search. It runs only when AUTOCRAFT_DISCORD_TOKEN_FILE and AUTOCRAFT_DISCORD_KEY_FILE
// are set; the runner starts it next to the worker server. See docs/pipeline.md.
import { loadConfig, type Config } from "../dash/server/config.ts";
import { TokenBox } from "../dash/server/crypto.ts";
import { bindSecrets, processAppKeys } from "../github/app-keys.ts";
import { githubIdentity } from "../github/identity.ts";
import { providerFor } from "../dash/server/provider.ts";
import { userForLogin } from "../dash/server/sessions.ts";
import { audit } from "../dash/audit.ts";
import { envVar } from "../env.ts";
import { localEmbedder } from "../embed/model.ts";
import { VectorIndex } from "../embed/vectors.ts";
import { Gateway } from "./gateway.ts";
import { Interactions } from "./interactions.ts";
import { Pings } from "./pings.ts";
import { Signals, dropSignalTexts } from "./signals.ts";
import { deleteRepliesOf } from "./replies.ts";
import { RestClient } from "./rest.ts";
import { Reactor } from "./react.ts";
import { forgetReporter } from "./file-issue.ts";
import { addFilingRepo, filingRepos, FilingRepoError, offerState, removeFilingRepo, setOffered } from "./filing-repos.ts";
import { forgetLink } from "./links.ts";
import { Search } from "./search.ts";
import { installAccountCommands } from "./commands.ts";
import { DecisionAlerts, installAlertCommands } from "./alerts.ts";
import { installSearchCommands } from "./search-commands.ts";
import { dropIssueTexts, installIssueNew } from "./issue-new.ts";
import { installPanel, postPanel } from "./panel.ts";
import { DiscordConfigError, readKeyFile, readTokenFile, type DiscordKeys } from "./keys.ts";
import { forgetAuthor, forgetMessages, handleDispatch, setStatus, upsertCategory, upsertChannel } from "./store.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";

type Channel = { id: string; name?: string; type?: number; parent_id?: string | null; position?: number };
const CATEGORY = 4;
// Text, announcement and forum channels can be watched; their threads and forum posts count under them.
const LISTED = new Set([0, 5, 15]);

/** Keeps the channel list the admin page shows; no message is involved. Rows of deleted channels are removed by handleDispatch, which runs first. */
export async function handleMeta(db: Db, type: string, d: unknown): Promise<void> {
  const x = d as { id?: string; name?: string; guild_id?: string; type?: number; parent_id?: string | null; position?: number; unavailable?: boolean; channels?: Channel[]; threads?: Channel[] };
  const thread = async (guildId: string, t: Channel): Promise<void> => {
    if (t.parent_id) await upsertChannel(db, { channelId: t.id, guildId, guildName: null, name: t.name ?? null, parentId: t.parent_id });
  };
  if (type === "GUILD_CREATE" && x.id) {
    for (const c of x.channels ?? []) {
      if (c.type === CATEGORY) await upsertCategory(db, { categoryId: c.id, guildId: x.id, name: c.name ?? null, position: c.position ?? null });
      else if (c.type === undefined || LISTED.has(c.type)) await upsertChannel(db, { channelId: c.id, guildId: x.id, guildName: x.name ?? null, name: c.name ?? null, position: c.position, categoryId: c.parent_id });
    }
    for (const t of x.threads ?? []) await thread(x.id, t);
  } else if ((type === "CHANNEL_CREATE" || type === "CHANNEL_UPDATE") && x.id && x.guild_id && x.type === CATEGORY) {
    await upsertCategory(db, { categoryId: x.id, guildId: x.guild_id, name: x.name ?? null, position: x.position ?? null });
  } else if ((type === "CHANNEL_CREATE" || type === "CHANNEL_UPDATE") && x.id && x.guild_id && (x.type === undefined || LISTED.has(x.type))) {
    await upsertChannel(db, { channelId: x.id, guildId: x.guild_id, guildName: null, name: x.name ?? null, position: x.position, categoryId: x.parent_id });
  } else if ((type === "THREAD_CREATE" || type === "THREAD_UPDATE") && x.id && x.guild_id) {
    await thread(x.guild_id, x as Channel);
  } else if (type === "THREAD_LIST_SYNC" && x.guild_id) {
    for (const t of x.threads ?? []) await thread(x.guild_id, t);
  } else if ((type === "CHANNEL_DELETE" || type === "THREAD_DELETE") && x.id) {
    const gone = x.id;
    await db.run(db.k.deleteFrom("discord_channels").where((eb) => eb.or([eb("channel_id", "=", gone), eb("parent_id", "=", gone)])));
    await db.run(db.k.deleteFrom("discord_categories").where("category_id", "=", gone));
  } else if (type === "GUILD_DELETE" && x.id && !x.unavailable) {
    await db.run(db.k.deleteFrom("discord_channels").where("guild_id", "=", x.id));
    await db.run(db.k.deleteFrom("discord_categories").where("guild_id", "=", x.id));
  }
}

/**
 * The one handler of gateway events. Order matters: the mention rows and channel list change first; the pings then see
 * `discord_replies` intact, so a deleted ping or quoted message finds our reply and deletes it in Discord.
 */
export function dispatcher(db: Db, keys: DiscordKeys, interactions: Interactions, pings: Pings, signals?: Signals, reactor?: Reactor): (type: string, d: unknown) => Promise<void> {
  return async (type, d) => {
    const recorded = await handleDispatch(db, keys, type, d);
    if (recorded) await reactor?.recorded(recorded.channelId, recorded.messageId);
    await handleMeta(db, type, d);
    interactions.dispatch(type, d);
    await pings.dispatch(type, d);
    await signals?.dispatch(type, d);
  };
}

/** Decision alerts by direct message. The GitHub permissions of a linked login are read as the dashboard reads them, from the dashboard's configuration when this process has it, else from the cached permissions only. */
function installDecisionAlerts(db: Db, keys: DiscordKeys, rest: RestClient, interactions: Interactions, signal: AbortSignal, log: (l: string) => void): void {
  let config: Config | null = null;
  try { config = loadConfig(process.env); } catch (e) { log(`runner: Discord alerts use cached permissions only: ${(e as Error).message}`); }
  const appKeys = processAppKeys();
  if (config && appKeys) bindSecrets(config.secrets, appKeys);
  const box = config ? new TokenBox(config.secrets.sessionKey) : null;
  const provider = config ? providerFor(config, async () => await githubIdentity(db)) : null;
  const alerts = new DecisionAlerts({
    db, keys, rest, log, baseUrl: config?.baseUrl ?? envVar("BASE_URL") ?? null,
    // Without the dashboard configuration there is no token box: userForLogin then answers from cached permissions, as it does for agent tokens.
    userFor: async (login, role, forWrite) => await userForLogin(db, box as never, provider as never, login, role, forWrite),
  });
  installAlertCommands(interactions, alerts);
  alerts.start(signal);
}

/** Starts the gateway when configured. A bad configuration or a failed connection is logged and never stops the caller. */
export async function startDiscord(db: Db, signal: AbortSignal, log: (l: string) => void): Promise<void> {
  const tokenFile = envVar("DISCORD_TOKEN_FILE");
  if (!tokenFile) return;
  let token: string, keys: DiscordKeys;
  try {
    token = readTokenFile(tokenFile);
    const keyFile = envVar("DISCORD_KEY_FILE");
    if (!keyFile) throw new DiscordConfigError("AUTOCRAFT_DISCORD_KEY_FILE is not set");
    keys = readKeyFile(keyFile);
  } catch (e) {
    log(`runner: Discord not started: ${(e as Error).message}`);
    await setStatus(db, "failed", (e as Error).message);
    return;
  }
  const rest = new RestClient({ token });
  const embedder = localEmbedder({ threads: 2 });
  const index = new VectorIndex(embedder);
  // Start the model and index loads now so the first search is warm. Nothing waits for them; a search arriving earlier awaits the same in-flight loads.
  for (const [what, load] of [["embedding model", async () => void await embedder.embed(["warm"], "query")], ["vector index", () => index.ready(db)]] as const) {
    void Promise.resolve().then(load).catch((e) => log(`runner: Discord ${what} warm-up failed: ${(e as Error).message}`));
  }
  const search = new Search({ db, embedder, index, log });
  const interactions = new Interactions(rest, log);
  installSearchCommands(interactions, { db, keys, search });
  installAccountCommands(interactions, { db, keys });
  installPanel(interactions, db, installIssueNew(interactions, { db, keys, search, log }));
  installDecisionAlerts(db, keys, rest, interactions, signal, log);
  const pings = new Pings({ db, keys, rest, search, log });
  const signals = new Signals({ db, keys, log });
  const reactor = new Reactor({ db, rest, log });
  // A crash during a call can leave the question in a recorded prompt.
  try { await dropIssueTexts(db, true); await dropSignalTexts(db, true); } catch (e) { log(`runner: removing search texts failed: ${(e as Error).message}`); }
  const gw = new Gateway({
    token,
    log,
    onState: async (state, detail) => await setStatus(db, state, detail),
    onDispatch: dispatcher(db, keys, interactions, pings, signals, reactor),
  });
  log("runner: Discord mention counting, pings and search started");
  void gw.run(signal).catch((e: Error) => log(`runner: Discord stopped: ${e.message}`));
}

const USAGE = `usage: autocraft-server discord forget --message <message link or id> | --user <user id>
       autocraft-server discord channels
       autocraft-server discord watch <channel id> | unwatch <channel id>
       autocraft-server discord panel post <channel id>
       autocraft-server discord filing list | add <owner/name> | remove <owner/name>
       autocraft-server discord offer list | hide <name> | show <name>`;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function keysOrDie(): DiscordKeys {
  const f = envVar("DISCORD_KEY_FILE");
  if (!f) die("AUTOCRAFT_DISCORD_KEY_FILE is not set");
  try {
    return readKeyFile(f);
  } catch (e) {
    return die((e as Error).message);
  }
}

// Recorded in the audit log as `cli`: only someone with a shell on the host can run this.
async function discord(args: string[]): Promise<void> {
  const [sub, a, b] = args;
  const db = await openDb();
  if (sub === "forget" && (a === "--message" || a === "--user") && b) {
    const keys = keysOrDie();
    const id = a === "--message" ? (/\/channels\/\d+\/\d+\/(\d+)\/?(?:[?#].*)?$/.exec(b)?.[1] ?? (/^\d+$/.test(b) ? b : die("not a Discord message link or id"))) : /^\d+$/.test(b) ? b : die("not a Discord user id");
    if (a === "--message") {
      const n = await forgetMessages(db, keys, [id]);
      // Our reply to the message goes too: deleted in Discord first, then its row.
      const tokenFile = envVar("DISCORD_TOKEN_FILE");
      let replies = 0;
      if (tokenFile) {
        try {
          replies = await deleteRepliesOf(db, keys, new RestClient({ token: readTokenFile(tokenFile) }), [id], (l) => console.error(l));
        } catch (e) {
          console.error((e as Error).message);
        }
      }
      await audit(db, "cli", "discord-forget", "message", { rows: n, replies });
      console.log(`deleted ${n} mention ${n === 1 ? "row" : "rows"} and ${replies} ${replies === 1 ? "reply" : "replies"}`);
    } else {
      const n = await forgetAuthor(db, keys, id);
      const links = await forgetLink(db, keys, id);
      const signedIn = await forgetReporter(db, keys.hash("author", id));
      await audit(db, "cli", "discord-forget", "user", { rows: n, links, signedIn });
      console.log(`deleted ${n} mention ${n === 1 ? "row" : "rows"} and ${links} ${links === 1 ? "link" : "links"}${signedIn ? " and the GitHub sign-in" : ""}`);
    }
  } else if (sub === "channels") {
    for (const c of await db.all(db.k.selectFrom("discord_channels").select(["channel_id", "guild_name", "name", "watched"])
      .orderBy("guild_name", (o) => o.asc().nullsFirst()).orderBy("name", (o) => o.asc().nullsFirst())))
      console.log(`${c.watched ? "watched " : "-       "} ${c.channel_id} ${c.guild_name ?? "?"} / #${c.name ?? "?"}`);
  } else if ((sub === "watch" || sub === "unwatch") && a) {
    const r = await db.run(db.k.updateTable("discord_channels").set({ watched: sub === "watch" ? 1 : 0 }).where("channel_id", "=", a));
    if (!r.changes) die("no such channel; the bot has not reported it");
    await audit(db, "cli", sub === "watch" ? "discord-watch" : "discord-unwatch", a);
    console.log(`${sub === "watch" ? "watching" : "no longer watching"} ${a}`);
  } else if (sub === "panel" && a === "post" && b) {
    const tokenFile = envVar("DISCORD_TOKEN_FILE");
    if (!tokenFile) die("AUTOCRAFT_DISCORD_TOKEN_FILE is not set");
    let token: string;
    try { token = readTokenFile(tokenFile); } catch (e) { die((e as Error).message); }
    const r = await postPanel(db, new RestClient({ token }), b).catch((e: Error) => die(`posting the panel failed: ${e.message}`));
    if (!r) die("no such channel; the bot has not reported it");
    await audit(db, "cli", "discord-panel", b, { message: r.messageId, created: r.created });
    console.log(`${r.created ? "posted" : "updated"} the panel in ${b} (message ${r.messageId})${r.pinError ? `; not pinned: ${r.pinError}` : ""}`);
  } else if (sub === "filing" && a === "list") {
    for (const r of await filingRepos(db)) console.log(`${r.owner}/${r.name}  added ${r.addedAt.slice(0, 16).replace("T", " ")} by ${r.addedBy}`);
  } else if (sub === "filing" && a === "add" && b) {
    const r = await addFilingRepo(db, "cli", b).catch((e: Error) => die(e instanceof FilingRepoError ? e.message : `adding failed: ${e.message}`));
    console.log(`the Discord bot files into ${r.owner}/${r.name}`);
  } else if (sub === "filing" && a === "remove" && b) {
    if (!await removeFilingRepo(db, "cli", b)) die(`${b} is not a filing-only repo`);
    console.log(`the Discord bot no longer files into ${b}`);
  } else if (sub === "offer" && a === "list") {
    const o = await offerState(db);
    for (const r of o.repos) console.log(`${r.offered ? "offered" : "hidden "}  ${r.name}${r.label !== r.name ? `  (${r.label})` : ""}`);
    console.log(`${o.used} of ${o.max} places used`);
  } else if (sub === "offer" && (a === "hide" || a === "show") && b) {
    if (!await setOffered(db, "cli", b, a === "show")) die(`${b} is not a public tracked repo`);
    console.log(`the Discord bot ${a === "show" ? "offers" : "no longer offers"} ${b}`);
  } else die(USAGE);
}

export const commands = {
  discord: { summary: "Discord mentions: forget --message|--user | channels | watch | unwatch | panel post | filing list|add|remove | offer list|hide|show", run: (args: string[]) => discord(args) },
};
