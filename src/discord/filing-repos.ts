// Filing-only repos: public repos of any owner that the Discord issue bot offers without tracking them. Where the GitHub
// App covers the repo the bot files into it as the app ("Submit for me"); elsewhere the draft offers only the prefilled
// GitHub link. Coverage is read when it is needed (appCovers), never stored. Sync, the pipeline and the bot's search never
// read this table. The one write such a repo gets is the bot's new issue and its label (guardBotFiling in src/core/guard.ts).
import { execFile } from "node:child_process";
import { audit } from "../dash/audit.ts";
import { OWNER } from "../owners.ts";
import { listRepoOwner, ownerAllowed } from "../github/allowed-owners.ts";
import { appCoverage, githubIdentity } from "../github/identity.ts";
import { AppReadError, readEnv } from "../github/read.ts";
import { publicRepoNames } from "../public/status.ts";
import { trackedRepos } from "./store.ts";
import type { Db } from "../db/index.ts";

export class FilingRepoError extends Error {}

export type FilingRepo = { owner: string; name: string; addedBy: string; addedAt: string };
/** How the bot files into a filing-only repo: "submit" when the GitHub App covers it (Submit for me), else "link" (only the GitHub link). */
export type FilingMode = "submit" | "link";
/** A repo the bot offers: a public tracked repo, or a filing-only one. */
export type BotRepo = { owner: string; name: string; filingOnly: boolean };

const NAME = /^[A-Za-z0-9._-]{1,100}$/;
/** At most this many, so the bot's app select (25 options) keeps room for the tracked repos. */
export const FILING_MAX = 10;

export async function filingRepos(db: Db): Promise<FilingRepo[]> {
  return await db.all(db.k.selectFrom("discord_filing_repos").select(["owner", "name", "added_by as addedBy", "added_at as addedAt"]).orderBy("owner").orderBy("name"));
}

/** Names of tracked repos an operator hid from the bot's repo select. */
export async function hiddenRepoNames(db: Db): Promise<Set<string>> {
  return new Set((await db.all(db.k.selectFrom("discord_hidden_repos").select("name"))).map((r) => r.name));
}

/** The repos the bot offers, by name: the public tracked repos that are not hidden, then the filing-only ones. A tracked repo of the same name wins. */
export async function botRepos(db: Db): Promise<BotRepo[]> {
  const hidden = await hiddenRepoNames(db);
  const pub = new Set((await publicRepoNames(db)).filter((n) => !hidden.has(n)));
  const tracked = await trackedRepos(db);
  const names = new Set(tracked.map((t) => t.name.toLowerCase()));
  return [
    ...tracked.filter((t) => pub.has(t.name)).map((t) => ({ owner: t.owner, name: t.name, filingOnly: false })),
    ...(await filingRepos(db)).filter((f) => !names.has(f.name.toLowerCase())).map((f) => ({ owner: f.owner, name: f.name, filingOnly: true })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

export async function botRepo(db: Db, name: string): Promise<BotRepo | null> {
  return (await botRepos(db)).find((r) => r.name === name) ?? null;
}

/** What adding needs to know of a repo on GitHub; null when it does not exist or cannot be read. */
export type RepoFacts = { owner: string; name: string; private: boolean; hasIssues: boolean; archived: boolean };
export type ReadRepo = (owner: string, name: string) => Promise<RepoFacts | null>;

/**
 * Reads the repo through the read path: under the app identity as the owner's installation, or, when the app is not
 * installed on the owner, as the tracked owner's installation (a public repo is readable with any installation token).
 */
export const ghReadRepo: ReadRepo = async (owner, name) => {
  let env: Awaited<ReturnType<typeof readEnv>>;
  try {
    env = await readEnv(owner).catch(async (e: unknown) => { if (e instanceof AppReadError && e.notInstalled) return await readEnv(); throw e; });
  } catch (e) {
    throw new FilingRepoError(`GitHub could not be read: ${(e as Error).message}`);
  }
  const jq = "{owner: .owner.login, name: .name, private: .private, hasIssues: .has_issues, archived: .archived}";
  return await new Promise<RepoFacts | null>((resolve, reject) => execFile("gh", ["api", `repos/${owner}/${name}`, "--jq", jq], { timeout: 30_000, ...(env ? { env } : {}) }, (err, stdout, stderr) => {
    if (!err) { try { return resolve(JSON.parse(stdout) as RepoFacts); } catch { return reject(new FilingRepoError("GitHub sent an unreadable answer. Try again.")); } }
    if (/HTTP 404|Not Found/i.test(String(stderr))) return resolve(null);
    reject(new FilingRepoError(`GitHub could not be read: ${String(stderr || err.message).replace(/\s+/g, " ").trim().slice(0, 160)}`));
  }));
};

/** `owner/name`, also as a github.com URL. */
function parseSlug(input: string): { owner: string; name: string } {
  const parts = input.trim().replace(/^https:\/\/github\.com\//i, "").replace(/(?:\.git)?\/?$/, "").split("/");
  if (parts.length !== 2 || !OWNER.test(parts[0]!) || !NAME.test(parts[1]!)) throw new FilingRepoError("Give the repo as owner/name.");
  return { owner: parts[0]!, name: parts[1]! };
}

/**
 * Adds a filing-only repo after GitHub confirms that it is public and takes issues; the GitHub App need not cover it.
 * Refuses a name that is tracked, known under another owner, or already on the list, and an owner that is not an allowed
 * owner of the GitHub App (src/github/allowed-owners.ts) while that list has accounts, covered or not: an installation
 * the owner makes later is then kept. `mode` is the coverage read now ("link" also when GitHub could not confirm it, `why` says which).
 * Audited as `discord-filing-add` with the mode.
 */
export async function addFilingRepo(db: Db, by: string, input: string, deps: { read?: ReadRepo; mint?: (owner: string, repo: string) => Promise<string> } = {}): Promise<FilingRepo & { mode: FilingMode; why?: string }> {
  const asked = parseSlug(input);
  if ((await filingRepos(db)).length >= FILING_MAX) throw new FilingRepoError(`The bot files into at most ${FILING_MAX} filing-only repos; remove one first.`);
  const facts = await (deps.read ?? ghReadRepo)(asked.owner, asked.name);
  if (!facts) throw new FilingRepoError(`${asked.owner}/${asked.name} was not found.`);
  // GitHub's spelling: names are compared without case, and the bot shows them as GitHub does.
  const { owner, name } = facts;
  if (facts.private) throw new FilingRepoError(`${owner}/${name} is not public.`);
  if (!facts.hasIssues) throw new FilingRepoError(`${owner}/${name} has issues turned off.`);
  if (facts.archived) throw new FilingRepoError(`${owner}/${name} is archived.`);
  if (!await ownerAllowed(db, owner)) throw new FilingRepoError(`${owner} is not an allowed owner of the GitHub App.`);
  const tracked = await db.get(db.k.selectFrom("main.tracked_repos").select("name").where((eb) => eb(eb.fn("lower", ["name"]), "=", name.toLowerCase())));
  if (tracked) throw new FilingRepoError(`${tracked.name} is a tracked repo; the bot offers it while it is public.`);
  const known = await db.get(db.k.selectFrom("main.repos").select(["name", "owner"]).where((eb) => eb(eb.fn("lower", ["name"]), "=", name.toLowerCase())));
  if (known && known.owner.toLowerCase() !== owner.toLowerCase()) throw new FilingRepoError(`${name} is already known under ${known.owner}; repo names are unique across owners.`);
  const listed = await db.get(db.k.selectFrom("discord_filing_repos").select(["owner", "name"]).where((eb) => eb(eb.fn("lower", ["name"]), "=", name.toLowerCase())));
  if (listed) throw new FilingRepoError(`${listed.owner}/${listed.name} is already on the list.`);
  const c = await appCoverage(owner, name, deps.mint);
  const mode: FilingMode = c.kind === "covered" ? "submit" : "link";
  const row = { owner, name, added_by: by, added_at: new Date().toISOString() };
  await db.run(db.k.insertInto("discord_filing_repos").values(row));
  await audit(db, by, "discord-filing-add", name, { owner, mode, ...(c.kind !== "covered" && { why: c.why }) });
  await listRepoOwner(db, by, owner, "filing");
  return { owner, name, addedBy: by, addedAt: row.added_at, mode, ...(c.kind !== "covered" && { why: c.why }) };
}

/** How long a coverage reading is kept: one Discord session or Settings visit asks GitHub once per repo. */
export const COVERAGE_TTL_MS = 5 * 60_000;

/** Whether the GitHub App covers a repo; `why` is the reason when it does not. */
export type CoverageReading = { covered: boolean; why: string | null };

/**
 * Whether the GitHub App covers `owner/name`, read with appCoverage and kept COVERAGE_TTL_MS. A reading GitHub could not
 * confirm is not kept and answers with the last kept one, else not covered with GitHub's reason.
 */
export function coverageReader(mint?: (owner: string, repo: string) => Promise<string>, now: () => number = Date.now): (owner: string, name: string) => Promise<CoverageReading> {
  const memo = new Map<string, { at: number } & CoverageReading>();
  return async (owner, name) => {
    const key = `${owner}/${name}`.toLowerCase();
    const hit = memo.get(key);
    if (hit && now() - hit.at < COVERAGE_TTL_MS) return { covered: hit.covered, why: hit.why };
    const c = await appCoverage(owner, name, mint);
    if (c.kind === "unconfirmed") return hit ? { covered: hit.covered, why: hit.why } : { covered: false, why: c.why };
    const reading = { covered: c.kind === "covered", why: c.kind === "covered" ? null : c.why };
    memo.set(key, { at: now(), ...reading });
    return reading;
  };
}

/** The shared reader for the Discord draft, the Submit for me press and the Settings list. */
export const appCovers = coverageReader();

/** The filing-only repos with how the bot files into each now: Submit for me needs the app identity and the app's coverage; `why` says why a repo is link-only. */
export async function filingReposWithMode(db: Db, covers: (owner: string, name: string) => Promise<CoverageReading> = appCovers): Promise<(FilingRepo & { mode: FilingMode; why: string | null })[]> {
  const app = await githubIdentity(db) === "app";
  return await Promise.all((await filingRepos(db)).map(async (r) => {
    const c: CoverageReading = app ? await covers(r.owner, r.name) : { covered: false, why: "Filing from Discord needs the GitHub App identity." };
    return { ...r, mode: c.covered ? "submit" as const : "link" as const, why: c.why };
  }));
}

/** Removes a filing-only repo (`owner/name` or the bare name). Returns whether it was on the list. Audited as `discord-filing-remove`. */
export async function removeFilingRepo(db: Db, by: string, input: string): Promise<boolean> {
  const name = input.trim().split("/").pop() ?? "";
  const row = await db.get(db.k.selectFrom("discord_filing_repos").select(["owner", "name"]).where((eb) => eb(eb.fn("lower", ["name"]), "=", name.toLowerCase())));
  if (!row) return false;
  await db.run(db.k.deleteFrom("discord_filing_repos").where("name", "=", row.name));
  await audit(db, by, "discord-filing-remove", row.name, { owner: row.owner });
  return true;
}

/** The bot's select holds this many repos. */
export const BOT_SELECT_MAX = 25;
export type OfferRow = { name: string; label: string; offered: boolean };

/** Every public tracked repo (app label else name) with whether the bot offers it, and how many places of the select the offered repos plus the filing-only ones fill. */
export async function offerState(db: Db): Promise<{ repos: OfferRow[]; used: number; max: number }> {
  const hidden = await hiddenRepoNames(db);
  const names = await publicRepoNames(db);
  const labels = names.length ? await db.all(db.k.selectFrom("release_apps").select(["repo", "name"]).where("repo", "in", names)) : [];
  const label = new Map(labels.map((l) => [l.repo, l.name]));
  const repos = names.map((name) => ({ name, label: label.get(name) ?? name, offered: !hidden.has(name) })).sort((a, b) => a.label.localeCompare(b.label));
  return { repos, used: Math.min(BOT_SELECT_MAX, (await botRepos(db)).length), max: BOT_SELECT_MAX };
}

/** Offers or hides a public tracked repo in the bot's select. Returns false when the name is not one. Audited as `discord-offer-show` / `discord-offer-hide`. */
export async function setOffered(db: Db, by: string, name: string, offered: boolean): Promise<boolean> {
  if (!(await publicRepoNames(db)).includes(name)) return false;
  if (offered) await db.run(db.k.deleteFrom("discord_hidden_repos").where("name", "=", name));
  else await db.run(db.k.insertInto("discord_hidden_repos").values({ name, hidden_by: by, hidden_at: new Date().toISOString() }).onConflict((oc) => oc.column("name").doNothing()));
  await audit(db, by, offered ? "discord-offer-show" : "discord-offer-hide", name);
  return true;
}
