// Filing a drafted issue from Discord under the person's own GitHub account: the reporter sign-in, the junk check and
// the limits. The Discord flow (src/discord/issue-new.ts) calls fileIssue() when the person presses File it.
// The reporter's token set is kept by src/discord/reporter.ts; the sign-in routes are src/dash/server/reporter-signin.ts.
import { jevAvailable } from "../agents/jev.ts";
import { runModelStep, type ClaudeStep, type JevStep } from "../agents/step.ts";
import { envVar } from "../env.ts";
import { TokenBox } from "../dash/server/crypto.ts";
import { readSecrets } from "../dash/server/config.ts";
import { GitHubProvider, type Provider } from "../dash/server/provider.ts";
import { exec as defaultExec, type Exec } from "../fixup/git.ts";
import { createBotIssue, createReporterIssue, IssueError, labelBotIssue, labelReporterIssue, type Note } from "../github/write.ts";
import { githubIdentity } from "../github/identity.ts";
import { guardBotFiling } from "../core/guard.ts";
import { botRepo } from "./filing-repos.ts";
import { appChildEnv } from "../github/install-token.ts";
import { openAppKeys } from "../github/app-keys.ts";
import { JEV_PROMPTS } from "../prompts/index.ts";
import { isPublicRepo } from "../public/status.ts";
import { jevJunk, junkBand, junkState, parseJunk, type JunkAsk } from "./junk-ask.ts";
import { failReporter, forgetReporterRow, newReporterState, readReporter, reporterToken } from "./reporter.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";
import type { SelectQueryBuilder } from "kysely";
import { DISCORD_TAKE_WAIT_MS } from "./limits.ts";

/** Filing from Discord under the person's account is built but off: the sign-in needs a Discord identity step first, so a forwarded sign-in link cannot link someone else's GitHub account. While off, the draft offers only the prefilled GitHub link and the sign-in routes answer 404. */
export const FILING_IN_DISCORD = false;

export type IssueKind = "bug" | "feature";

export type FileRequest = {
  /** Keyed hash of the Discord user (`keys.hash("author", id)`). */
  reporter: string;
  repo: string;
  title: string;
  body: string;
  kind: IssueKind;
  /** The junk check already ran on the person's first message; the draft is not checked again. */
  junkChecked?: boolean;
};

export type FileResult =
  /** The person has not signed in with GitHub (or the sign-in expired): show a link button to `url`. */
  | { status: "sign-in"; url: string }
  | { status: "filed"; number: number; url: string; login: string }
  /** Not filed: a limit, the junk check or a GitHub error. `reason` is shown to the person; the flow offers the GitHub link instead. */
  | { status: "refused"; reason: string };

export type FileDeps = { db: Db; log: (line: string) => void };

/** Limits over 24 hours. `DAILY_WRITES` is the GitHub write limit of the audit action `discord-issue-open`. */
export const PER_LOGIN = 3;
export const PER_REPO = 30;
export const DAILY_WRITES = 50;
export const FOOTER = "Filed from Discord with AutoCraft.";
export const AUDIT_ACTION = "discord-issue-open";
export const BOT_ACTION = "discord-issue-bot";
/** The `login` of a `discord_filed` row the GitHub App filed; no GitHub login has parentheses, so it never meets a reporter's own. The per-person limit counts by `reporter`. */
export const BOT_LOGIN = "(app)";
const NAME_MAX = 64;
const DAY_MS = 86_400_000;
const TITLE_MAX = 256;
export const JUNK_REFUSAL = "That does not look like a bug report or a feature request.";
export const JUNK_UNKNOWN = "The report could not be checked just now. Try again in a few minutes.";
export const modelJunkJudge = (): NonNullable<FileHooks["judge"]> => modelJudge;
const LABEL: Record<IssueKind, string> = { bug: "bug", feature: "enhancement" };

/** What a test replaces: the token box and provider (else the secrets file's), `gh`, the junk judges, the clock and the public base URL. */
export type FileHooks = {
  box?: TokenBox; provider?: Provider; exec?: Exec; baseUrl?: string | null; now?: () => number;
  judge?: { jev: (db: Db, a: JunkAsk) => Promise<number | null>; haiku: (db: Db, a: JunkAsk) => Promise<boolean | null> };
};

const JEV_STEP: JevStep<JunkAsk, number> = {
  provider: "jev", id: "discord.junk.jev",
  request: (a) => ({ item: { ref: "discord" }, body: JSON.stringify({ ...JEV_PROMPTS["discord.junk.jev"].request, state: junkState(a) }) }),
  parse: (answers, _a, ctx) => {
    const p = ctx.code === 0 ? jevJunk(answers) : null;
    return p === null ? null : { value: p };
  },
};
const HAIKU_STEP: ClaudeStep<JunkAsk, boolean> = {
  provider: "claude", id: "discord.junk.haiku",
  toPrompt: (a) => [a],
  parse: async (text) => {
    const v = parseJunk(text);
    return v === null ? null : { value: v };
  },
};
const modelJudge: NonNullable<FileHooks["judge"]> = {
  jev: async (db, a) => { const r = await runModelStep(db, JEV_STEP, a); return r.ok ? r.value : null; },
  haiku: async (db, a) => { const r = await runModelStep(db, HAIKU_STEP, a, { maxWaitMs: DISCORD_TAKE_WAIT_MS }); return r.ok ? r.value : null; },
};

/** Jev first, Haiku where Jev is unsure or unavailable. With no model answer the draft is not filed ("unknown"): the person still has the GitHub link. The texts of the calls are deleted when they end. */
export async function junkCheck(db: Db, a: JunkAsk, judge: NonNullable<FileHooks["judge"]>, log: (l: string) => void): Promise<"junk" | "ok" | "unknown"> {
  try {
    if (await jevAvailable(db)) {
      const p = await judge.jev(db, a);
      const band = p === null ? "unsure" : junkBand(p);
      if (band === "yes") return "junk";
      if (band === "no") return "ok";
    }
    const v = await judge.haiku(db, a);
    return v === null ? "unknown" : v ? "junk" : "ok";
  } catch (e) {
    log(`discord: junk check failed: ${(e as Error).message.slice(0, 200)}`);
    return "unknown";
  } finally {
    try {
      await db.run(db.k.deleteFrom("agent_run_texts").where("run_id", "in", (eb) => eb.selectFrom("agent_runs").select("id").where("step", "=", "discord-issue").where("state", "<>", "running")));
    } catch (e) { log(`discord: removing junk texts failed: ${(e as Error).message}`); }
  }
}

async function secretsOf(db: Db, env = process.env): Promise<{ box: TokenBox; provider: Provider } | null> {
  try {
    const s = readSecrets(envVar("SECRETS_FILE", env));
    const app = (await openAppKeys(db, env))?.current() ?? null;
    return app ? { box: new TokenBox(s.sessionKey), provider: new GitHubProvider(app.clientId, app.clientSecret) } : null;
  } catch {
    return null;
  }
}

const count = async (db: Db, q: SelectQueryBuilder<any, any, { c: number }>): Promise<number> => Number((await db.get(q))!.c);

export async function fileIssue(deps: FileDeps, req: FileRequest, hooks: FileHooks = {}): Promise<FileResult> {
  const { db, log } = deps;
  const now = (hooks.now ?? Date.now)();
  const title = req.title.replace(/\s+/g, " ").trim();
  const body = req.body.trim();
  if (!await isPublicRepo(db, req.repo)) return { status: "refused", reason: "That repo is not open for filing from Discord." };
  if (!title || !body) return { status: "refused", reason: "The title and the description must not be empty." };
  if (title.length > TITLE_MAX) return { status: "refused", reason: "The title is too long." };

  const keys = hooks.box && hooks.provider ? { box: hooks.box, provider: hooks.provider } : await secretsOf(db);
  const baseUrl = (hooks.baseUrl === undefined ? envVar("BASE_URL") ?? null : hooks.baseUrl)?.replace(/\/+$/, "") ?? null;
  if (!keys || !baseUrl) return { status: "refused", reason: "Filing from Discord is not set up." };

  const tok = await reporterToken(db, keys.box, keys.provider, req.reporter, now);
  if (!tok.ok && tok.signIn) return { status: "sign-in", url: `${baseUrl}/discord/github/start?state=${encodeURIComponent(await newReporterState(db, req.reporter, now))}` };
  if (!tok.ok) return { status: "refused", reason: "GitHub did not answer. Try again in a minute." };

  const since = new Date(now - DAY_MS).toISOString();
  await db.run(db.k.deleteFrom("discord_filed").where("at", "<", since));
  if (await count(db, db.k.selectFrom("discord_filed").select((eb) => eb.fn.countAll<number>().as("c")).where("login", "=", tok.login).where("at", ">=", since)) >= PER_LOGIN) return { status: "refused", reason: `You have filed ${PER_LOGIN} issues from Discord in the last 24 hours.` };
  if (await count(db, db.k.selectFrom("discord_filed").select((eb) => eb.fn.countAll<number>().as("c")).where("repo", "=", req.repo).where("at", ">=", since)) >= PER_REPO) return { status: "refused", reason: "This repo has reached its limit of issues filed from Discord today." };
  if (await count(db, db.k.selectFrom("audit").select((eb) => eb.fn.countAll<number>().as("c")).where("action", "=", AUDIT_ACTION).where("at", ">=", since).where(kx.jsonText(db, "details", "$.state"), "<>", "failed")) >= DAILY_WRITES) return { status: "refused", reason: "Filing from Discord has reached its daily limit." };
  // The slot is reserved before any await, so parallel sessions of one person cannot pass the limit together; every failure below frees it.
  const slot = Number((await db.get(db.k.insertInto("discord_filed").values({ repo: req.repo, number: 0, login: tok.login, reporter: req.reporter, at: new Date(now).toISOString() }).returning(kx.rowid("discord_filed").as("rowid"))))!.rowid);
  let filed = false;
  try {
    const junk = req.junkChecked ? "ok" : await junkCheck(db, { title, body }, hooks.judge ?? modelJudge, log);
    if (junk === "junk") return { status: "refused", reason: JUNK_REFUSAL };
    if (junk === "unknown") return { status: "refused", reason: JUNK_UNKNOWN };

    const run = hooks.exec ?? defaultExec;
    const env = appChildEnv(tok.access);
    const asUser: Exec = (cmd, args, opts) => run(cmd, args, { ...opts, env, replaceEnv: true });
    const w = { db, login: tok.login, now: () => now };
    let made: { number: number; url: string };
    try {
      made = await createReporterIssue(w, asUser, { repo: req.repo, title, body: `${body}\n\n${FOOTER}` });
    } catch (e) {
      const err = String((e as Error).message ?? e);
      if (/HTTP 401|bad credentials/i.test(err)) {
        await failReporter(db, req.reporter, tok.version, now);
        return { status: "sign-in", url: `${baseUrl}/discord/github/start?state=${encodeURIComponent(await newReporterState(db, req.reporter, now))}` };
      }
      if (e instanceof IssueError && !e.clear) { filed = true; /* the issue may exist: the slot stays used */ return { status: "refused", reason: "GitHub could not be reached. Try again in a minute." }; }
      return { status: "refused", reason: "GitHub did not accept the issue." };
    }
    filed = true;
    await db.run(db.k.updateTable("discord_filed").set({ number: made.number }).where(kx.rowid("discord_filed"), "=", slot));
    // A label is a courtesy: GitHub refuses it when the repo has no such label or the account may not set labels.
    await labelReporterIssue(w, asUser, { repo: req.repo, number: made.number, label: LABEL[req.kind] });
    return { status: "filed", number: made.number, url: made.url, login: tok.login };
  } finally {
    if (!filed) await db.run(db.k.deleteFrom("discord_filed").where(kx.rowid("discord_filed"), "=", slot));
  }
}

/** Removes the person's GitHub sign-in (on /autocraft unlink and `discord forget --user`) and queues its token's revoke. Returns whether one existed. */
export async function forgetReporter(db: Db, reporter: string): Promise<boolean> {
  return await forgetReporterRow(db, reporter);
}

// ---- Submit for me: the GitHub App files the draft ---------------------------------------------------------------

export type BotRequest = FileRequest & {
  /** The Discord name the issue credits (display name, else user name). */
  reporterName: string;
  /** Whether a model wrote the draft: it decides the note line. */
  drafted: boolean;
};

export type BotResult = { status: "filed"; number: number; url: string } | { status: "refused"; reason: string };

/** The reporter as the issue shows them: a Discord handle (`@name`) in a code span so GitHub does not ping a user of that name; anything else is one line without mentions, links or Markdown, capped. */
export function creditName(name: string): string {
  if (/^@[a-z0-9_.]{2,32}$/.test(name)) return `\`${name}\``;
  const t = name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\b[a-z][\w+.-]*:\/\/\S*|\bwww\.\S*/gi, " ").replace(/[@#*_~`|<>\[\]()\\]/g, "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  return t || "a Discord member";
}

export const botFooter = (name: string): string => `Reported on Discord by ${creditName(name)}. Filed by AutoCraft on their behalf.`;

const botFiledSince = (db: Db, since: string) => db.k.selectFrom("audit").select((eb) => eb.fn.countAll<number>().as("c"))
  .where("action", "in", [AUDIT_ACTION, BOT_ACTION]).where("at", ">=", since).where(kx.jsonText(db, "details", "$.state"), "<>", "failed");

/** Why the GitHub App cannot file for this person in this repo now, or null when it can: the app identity and the limits over 24 hours (per person, per repo, all of Discord). Reads only; the draft shows "Submit for me" only when this is null. */
export async function botRefusal(db: Db, reporter: string, repo: string, now: number = Date.now(), /** Rows of this request already reserved in `discord_filed`. */ reserved = 0): Promise<string | null> {
  if (!await botRepo(db, repo)) return "That repo is not open for filing from Discord.";
  if (await githubIdentity(db) !== "app") return "Filing from Discord is not set up.";
  const since = new Date(now - DAY_MS).toISOString();
  if (await count(db, db.k.selectFrom("discord_filed").select((eb) => eb.fn.countAll<number>().as("c")).where("reporter", "=", reporter).where("at", ">=", since)) >= PER_LOGIN + reserved) return `You have filed ${PER_LOGIN} issues from Discord in the last 24 hours.`;
  if (await count(db, db.k.selectFrom("discord_filed").select((eb) => eb.fn.countAll<number>().as("c")).where("repo", "=", repo).where("at", ">=", since)) >= PER_REPO + reserved) return "This repo has reached its limit of issues filed from Discord today.";
  if (await count(db, botFiledSince(db, since)) >= DAILY_WRITES) return "Filing from Discord has reached its daily limit.";
  return null;
}

/** "Submit for me": the GitHub App files the draft, crediting the Discord reporter. Same limits (counted per Discord person) and junk check as fileIssue. */
export async function fileAsBot(deps: FileDeps, req: BotRequest, hooks: Pick<FileHooks, "exec" | "now" | "judge"> & { mint?: (owner: string, repo: string) => Promise<string> } = {}): Promise<BotResult> {
  const { db, log } = deps;
  const now = (hooks.now ?? Date.now)();
  const title = req.title.replace(/\s+/g, " ").trim();
  const body = req.body.trim();
  if (!title || !body) return { status: "refused", reason: "The title and the description must not be empty." };
  if (title.length > TITLE_MAX) return { status: "refused", reason: "The title is too long." };
  await db.run(db.k.deleteFrom("discord_filed").where("at", "<", new Date(now - DAY_MS).toISOString()));
  const why = await botRefusal(db, req.reporter, req.repo, now);
  if (why) return { status: "refused", reason: why };
  // The slot is reserved and the limits counted again with it, so parallel presses never pass a limit together; every failure below frees it.
  const slot = Number((await db.get(db.k.insertInto("discord_filed").values({ repo: req.repo, number: 0, login: BOT_LOGIN, reporter: req.reporter, at: new Date(now).toISOString() }).returning(kx.rowid("discord_filed").as("rowid"))))!.rowid);
  let filed = false;
  try {
    const late = await botRefusal(db, req.reporter, req.repo, now, 1);
    if (late) return { status: "refused", reason: late };
    const junk = req.junkChecked ? "ok" : await junkCheck(db, { title, body }, hooks.judge ?? modelJudge, log);
    if (junk === "junk") return { status: "refused", reason: JUNK_REFUSAL };
    if (junk === "unknown") return { status: "refused", reason: JUNK_UNKNOWN };
    const g = await guardBotFiling(db, req.repo);
    if ("refused" in g) return { status: "refused", reason: "Filing from Discord is not set up." };
    const run = hooks.exec ?? defaultExec;
    const w = { db, login: "discord", now: () => now, ...(hooks.mint && { mint: hooks.mint }) };
    const note: Note = req.drafted ? { by: "model", kind: "issue", model: "haiku" } : { by: "fixed" };
    let made: { number: number; url: string };
    try {
      made = await createBotIssue(w, g, run, { repo: req.repo, title, body: `${body}\n\n${botFooter(req.reporterName)}` }, note);
    } catch (e) {
      if (e instanceof IssueError && !e.clear) { filed = true; return { status: "refused", reason: "GitHub could not be reached. Try again in a minute." }; }
      log(`discord: filing as the app failed: ${String((e as Error).message ?? e).slice(0, 200)}`);
      // The installation no longer reaches the repo (the app was removed from it, or from its owner).
      if (e instanceof IssueError && e.noAccess) return { status: "refused", reason: "AutoCraft can no longer file issues in this repo." };
      // No token (GitHub 5xx, network, rate limit): nothing was sent, so the slot is freed.
      if (e instanceof IssueError && e.unsent) return { status: "refused", reason: "GitHub could not be reached. Try again in a minute." };
      return { status: "refused", reason: "GitHub did not accept the issue." };
    }
    filed = true;
    await db.run(db.k.updateTable("discord_filed").set({ number: made.number }).where(kx.rowid("discord_filed"), "=", slot));
    await labelBotIssue(w, g, run, { repo: req.repo, number: made.number, label: LABEL[req.kind] });
    return { status: "filed", number: made.number, url: made.url };
  } finally {
    if (!filed) await db.run(db.k.deleteFrom("discord_filed").where(kx.rowid("discord_filed"), "=", slot));
  }
}
