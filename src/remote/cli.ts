// `autocraft-server remote cooloff clear <login>`: ends the cool-off of a login's helpers (src/remote/cooloff.ts).
// `autocraft-server remote token <login>`: makes a Task Runner credential for a maintainer or operator and prints only the credential,
// so it can be piped into `autocraft login --stdin` on the same host without anyone seeing it (no device login needed).
// `autocraft-server remote test-call <login> [<repo>#<n>] [--slot]`: queues a one-line small-tier call bound to the login's own
// Task Runners (in a slot with --slot, else their own lane), waits for it and prints the lane that took it.
import { audit } from "../dash/audit.ts";
import { createToken, MCP_TOKENS_PER_LOGIN } from "../dash/mcp/tokens.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import type { ItemRef } from "../../web/src/api/types.ts";
import { awaitCall, enqueueCall } from "./calls.ts";
import { clearCooloff } from "./cooloff.ts";
import { openDb } from "../db/open.ts";
import { loadAccess } from "../data/access/index.ts";
import { loadCalls } from "../data/runners/index.ts";
import type { Db } from "../db/index.ts";

/** The access row of a login (compared without case), or null. */
const accessOf = async (db: Db, login: string): Promise<{ login: string; role: string } | null> => [...(await loadAccess(db, [login])).values()][0] ?? null;

export const commands = {
  remote: {
    summary: "remote cooloff clear <login>: lets the login's helpers claim calls again after a cool-off; remote token <login> [--label <text>]: a Task Runner credential on stdout, for piping into autocraft login --stdin; remote test-call <login> [<repo>#<n>] [--slot]: a one-line call on the login's own Task Runner",
    async run(args: string[]): Promise<void> {
      if (args[0] === "token") return await makeToken(args.slice(1));
      if (args[0] === "test-call") return await testCall(args.slice(1));
      if (args[0] !== "cooloff" || args[1] !== "clear" || !args[2] || args.length > 3) {
        console.error("usage: autocraft-server remote cooloff clear <login>");
        process.exit(1);
      }
      console.log(await clearCooloff(await openDb(), args[2], "cli") ? `cleared the cool-off of ${args[2]}` : `${args[2]} is not cooling off`);
    },
  },
};

const TOKEN_USAGE = "usage: autocraft-server remote token <login> [--label <text>] | autocraft login --stdin <dashboard url>   (stdout must not be a terminal)";

async function makeToken(args: string[]): Promise<void> {
  const login = args[0];
  const at = args.indexOf("--label");
  const label = at > 0 ? args[at + 1] : "Task Runner";
  if (!login || login.startsWith("-") || (at > 0 && !label) || args.length !== (at > 0 ? 3 : 1)) {
    console.error(TOKEN_USAGE);
    process.exit(1);
  }
  // The token is printed once and only into a pipe: on a terminal it would be on screen and in scrollback.
  if (process.stdout.isTTY) {
    console.error(`refused: stdout is a terminal\n${TOKEN_USAGE}`);
    process.exit(1);
  }
  const db = await openDb();
  const role = (await accessOf(db, login))?.role;
  if (role !== "maintainer" && role !== "operator") {
    console.error(`refused: ${login} is ${role ? `a ${role}` : "not on the access list"}; only maintainers and operators run model calls`);
    process.exit(1);
  }
  let made: Awaited<ReturnType<typeof createToken>>;
  try {
    made = await createToken(db, login, label, { kind: "runner" });
  } catch (e) {
    console.error(`refused: ${(e as Error).message} (at most ${MCP_TOKENS_PER_LOGIN} Task Runners per login; remove one on the Connect page)`);
    process.exit(1);
  }
  const { token, row } = made;
  await audit(db, "cli", "runner-approve", login, { id: row.id, label: row.label ?? undefined, via: "cli" });
  process.stdout.write(`${token}\n`);
  console.error(`made Task Runner credential ${row.id} (${row.label ?? "no label"}) for ${login}; remove it on the Connect page`);
}

const TEST_CALL_USAGE = "usage: autocraft-server remote test-call <login> [<repo>#<n>] [--slot]";
const TEST_CALL_WAIT_MS = 15 * 60_000;

/**
 * Queues a small-tier call with a one-line prompt bound to `login` and waits for its reply. Without an item the call names no
 * repo, which only an operator's runner takes. Prints the lease's lane: the slot lane counts toward Max calls at once.
 */
async function testCall(args: string[]): Promise<void> {
  const slot = args.includes("--slot");
  const rest = args.filter((a) => a !== "--slot");
  const [login, item] = rest;
  const at = item?.lastIndexOf("#") ?? -1;
  const ref: ItemRef | null = item && at > 0 && /^[0-9]+$/.test(item.slice(at + 1)) ? { repo: item.slice(0, at), number: Number(item.slice(at + 1)) } : null;
  if (!login || login.startsWith("-") || rest.length > 2 || (item !== undefined && !ref)) {
    console.error(TEST_CALL_USAGE);
    process.exit(1);
  }
  const db = await openDb();
  // access.login compares without case (NOCASE, citext): the call is bound to the login as the access list spells it.
  const user = await accessOf(db, login);
  const role = user?.role;
  if (!user || (role !== "maintainer" && role !== "operator")) {
    console.error(`refused: ${login} is ${role ? `a ${role}` : "not on the access list"}; only maintainers and operators run model calls`);
    process.exit(1);
  }
  const promptId = "remote.test", model = CLAUDE_PROMPTS["classify.haiku"].models[0]!;
  const args0 = ["-p", "--model", model, "--effort", "low", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"];
  const id = await enqueueCall(db, {
    promptId, promptVersion: "1", tier: "small", effort: "low", askedModel: model, items: ref ? [ref] : [], level: 0, maxAttempts: 1, forLogin: user.login, boundSlot: slot,
    bundle: { promptId, promptVersion: "1", tier: "small", effort: "low", timeoutSeconds: 120, maxTurns: null, stdin: "Reply with the single word: ok", system: null, mounts: [], mcpServers: [], keepSession: false, hints: { claude: { args: args0 } } },
  });
  console.log(`queued call ${id} for ${user.login}'s Task Runner (${slot ? "a slot" : "the own lane"}); waiting up to ${TEST_CALL_WAIT_MS / 60_000} min`);
  let reply: string | null = null;
  try {
    const o = await awaitCall(db, id, { maxWaitMs: TEST_CALL_WAIT_MS, log: (line) => console.error(line) });
    if (o.state === "done") reply = o.text.trim().slice(0, 80);
  } catch (e) {
    // A wait limit or a missing taker: the call was withdrawn, and its row says why.
    console.error((e as Error).message);
  }
  const r = (await loadCalls(db, [id])).get(id)!;
  const lane = r.userLogin === null ? "no lease" : `leased by ${r.userLogin} in ${r.ownLane ? "the own lane" : "a slot"}`;
  console.log(`call ${id}: ${r.state}, ${lane}${reply !== null ? `; reply: ${reply}` : r.error ? `; ${r.error}` : ""}`);
  if (reply === null) process.exit(1);
}
