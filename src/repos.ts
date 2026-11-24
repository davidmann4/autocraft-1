// Tracked repos: the admin-chosen subset of the org that sync, the pipeline and
// the dashboard work on. `repos` holds every org repo; `tracked_repos` selects.
import { audit } from "./dash/audit.ts";
import { execFile } from "node:child_process";
import { DEFAULT_OWNER, OWNER, reloadOwners, splitSlug } from "./owners.ts";
import { appCoverage, githubIdentity, setGithubIdentityChecked } from "./github/identity.ts";
import { listRepoOwner, ownerAllowed } from "./github/allowed-owners.ts";
import { readAppSecrets } from "./github/install-token.ts";
import { PilotError, setRepoPipeline } from "./pilot.ts";
import { AppReadError, readEnv } from "./github/read.ts";
import type { Db } from "./db/index.ts";
import { openDb } from "./db/open.ts";
export { SHADOWED_TABLES } from "./db/scoped.ts";

export class RepoError extends Error {}

export const trackedNames = async (db: Db): Promise<string[]> =>
  (await db.all(db.k.selectFrom("main.tracked_repos").select("name").orderBy("name"))).map((r) => r.name);

export const isTracked = async (db: Db, name: string): Promise<boolean> =>
  await db.get(db.k.selectFrom("main.tracked_repos").select((eb) => eb.lit(1).as("one")).where("name", "=", name)) !== undefined;

const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** Tracks `name` (a storytold repo) or `owner/name`. Repo names are unique across owners. */
export async function trackRepo(db: Db, by: string, input: string): Promise<boolean> {
  const { owner, name } = splitSlug(input);
  if (!NAME.test(name)) throw new RepoError("Not a repo name.");
  if (!OWNER.test(owner)) throw new RepoError("Not an owner name.");
  // A filing-only repo of the Discord bot holds its name (and owner) outside `repos`; tracking would give one name two owners.
  const filing = await db.get(db.k.selectFrom("discord_filing_repos").select(["owner", "name"]).where((eb) => eb(eb.fn("lower", ["name"]), "=", name.toLowerCase())));
  if (filing) throw new RepoError(`${filing.owner}/${filing.name} is a filing-only repo of the Discord bot; remove it there first (Discord page, or discord filing remove).`);
  const known = await db.get(db.k.selectFrom("main.repos").select("owner").where("name", "=", name));
  // A bare name means the repo as already known, whoever owns it.
  if (known && input.includes("/") && known.owner.toLowerCase() !== owner.toLowerCase()) {
    throw new RepoError(`${name} is already known under ${known.owner}; repo names are unique across owners.`);
  }
  if (!known) await db.run(db.k.insertInto("main.repos").values({ name, owner }));
  await reloadRepoOwners(db);
  const r = await db.run(db.k.insertInto("main.tracked_repos").values({ name, added_by: by, added_at: new Date().toISOString() })
    .onConflict((oc) => oc.doNothing()));
  if (r.changes) {
    // Items updated while the repo was untracked were never read; the next sync reads the repo in full.
    await db.run(db.k.updateTable("main.repos").set({ high_water: null, synced_at: null, reconciled_at: null }).where("name", "=", name));
    await audit(db, by, "repo-track", name);
    await listRepoOwner(db, by, (await db.get(db.k.selectFrom("main.repos").select("owner").where("name", "=", name)))?.owner ?? owner, "track");
  }
  return r.changes > 0;
}

/** Whether `owner/name` exists and the account can read it. */
export type RepoExists = (owner: string, name: string) => Promise<boolean>;

export const ghRepoExists: RepoExists = async (owner, name) => {
  let env: Awaited<ReturnType<typeof readEnv>>;
  try { env = await readEnv(owner); } catch (e) { if (e instanceof AppReadError && e.notInstalled) return false; throw e; }
  return new Promise((resolve) => execFile("gh", ["api", `repos/${owner}/${name}`, "--jq", ".full_name"], { timeout: 30_000, ...(env ? { env } : {}) }, (err) => resolve(!err)));
};

/**
 * trackRepo for an operator's input: a repo of another owner is tracked only when GitHub confirms it
 * and storytold has no repo of that name (names are unique across owners).
 */
export async function trackRepoChecked(db: Db, by: string, input: string, exists: RepoExists = ghRepoExists, mint?: (owner: string, repo: string) => Promise<string>): Promise<boolean> {
  const { owner, name } = splitSlug(input);
  const known = NAME.test(name) && await db.get(db.k.selectFrom("main.repos").select((eb) => eb.lit(1).as("one")).where("name", "=", name)) !== undefined;
  if (input.includes("/") && owner.toLowerCase() !== DEFAULT_OWNER && OWNER.test(owner) && NAME.test(name) && !known) {
    if (await exists(DEFAULT_OWNER, name)) throw new RepoError(`${DEFAULT_OWNER}/${name} exists; repo names are unique across owners.`);
    if (!(await exists(owner, name))) throw new RepoError(`${owner}/${name} was not found or is not readable.`);
  }
  const known2 = NAME.test(name) ? await db.get(db.k.selectFrom("main.repos").select("owner").where("name", "=", name)) : undefined;
  const repoOwner = input.includes("/") ? owner : known2?.owner ?? owner;
  if (OWNER.test(repoOwner) && !await ownerAllowed(db, repoOwner)) throw new RepoError(`${repoOwner} is not an allowed owner of the GitHub App.`);
  // Under the GitHub App identity a repo the installation does not cover could not be written to.
  if (await githubIdentity(db) === "app" && NAME.test(name) && OWNER.test(owner)) {
    const c = await appCoverage(repoOwner, name, mint);
    if (c.kind === "uncovered") throw new RepoError(`The GitHub App does not cover ${name}: ${c.why}`);
    if (c.kind === "unconfirmed") throw new RepoError(`GitHub could not confirm the GitHub App's installation for ${name}. Try again.`);
  }
  return await trackRepo(db, by, input);
}

export async function untrackRepo(db: Db, by: string, input: string): Promise<boolean> {
  const { name } = splitSlug(input);
  const r = await db.run(db.k.deleteFrom("main.tracked_repos").where("name", "=", name));
  if (r.changes) await audit(db, by, "repo-untrack", name);
  return r.changes > 0;
}

// Deletes the mirrored items and comments of one untracked repo.
export async function purgeRepo(db: Db, input: string): Promise<{ items: number; comments: number }> {
  const { name } = splitSlug(input);
  if (await isTracked(db, name)) throw new RepoError(`${name} is tracked; untrack it first.`);
  return await db.write(async () => {
    const comments = Number((await db.run(db.k.deleteFrom("main.comments").where("repo", "=", name))).changes);
    const items = Number((await db.run(db.k.deleteFrom("main.items").where("repo", "=", name))).changes);
    await db.run(db.k.updateTable("main.repos").set({ high_water: null, synced_at: null, reconciled_at: null }).where("name", "=", name));
    return { items, comments };
  });
}

export type RepoRow = {
  name: string; owner: string; tracked: number; pipeline: number; open_prs: number | null; open_issues: number | null; rows: number; synced_at: string | null;
};

// Every known repo, tracked first.
export async function listAll(db: Db): Promise<RepoRow[]> {
  const first = db.k.selectFrom("main.repos as r").select((eb) => [
    "r.name", "r.owner",
    eb.case().when(eb.exists(eb.selectFrom("main.tracked_repos as t").select(eb.lit(1).as("one")).whereRef("t.name", "=", "r.name"))).then(1).else(0).end().as("tracked"),
    eb.fn.coalesce(eb.selectFrom("main.tracked_repos as t").select("t.pipeline").whereRef("t.name", "=", "r.name"), eb.lit(0)).as("pipeline"),
    "r.open_prs", "r.open_issues", "r.synced_at",
    eb.selectFrom("main.items as i").select(eb.fn.countAll<number>().as("n")).whereRef("i.repo", "=", "r.name").as("rows"),
  ]).$narrowType<{ rows: number }>();
  const second = db.k.selectFrom("main.tracked_repos as t").select((eb) => [
    "t.name", eb.val("storytold").as("owner"), eb.lit(1).as("tracked"), "t.pipeline",
    eb.lit(null).as("open_prs"), eb.lit(null).as("open_issues"), eb.lit(null).as("synced_at"),
    eb.selectFrom("main.items as i").select(eb.fn.countAll<number>().as("n")).whereRef("i.repo", "=", "t.name").as("rows"),
  ]).$narrowType<{ rows: number }>().where((eb) => eb("t.name", "not in", eb.selectFrom("main.repos as r2").select("r2.name")));
  return await db.all(first.unionAll(second).orderBy("tracked", "desc").orderBy("name"));
}

/** The dashboard's, runner's and CLI jobs' view of the database: tracked repos only (src/db/scoped.ts). */
export async function scopeToTracked(db: Db): Promise<void> {
  await db.scope();
}

async function list(): Promise<void> {
  const db = await openDb();
  console.log(`${"repo".padEnd(28)} ${"tracked".padEnd(7)} ${"pipeline".padEnd(8)} ${"open PRs".padStart(8)} ${"open iss".padStart(8)} ${"mirrored".padStart(8)}  synced_at`);
  for (const r of await listAll(db)) {
    console.log(`${r.name.padEnd(28)} ${(r.tracked ? "yes" : "-").padEnd(7)} ${(r.tracked ? (r.pipeline ? "on" : "off") : "-").padEnd(8)} ${String(r.open_prs ?? "-").padStart(8)} ${String(r.open_issues ?? "-").padStart(8)} ${String(r.rows).padStart(8)}  ${r.synced_at ?? "-"}`);
  }
}

function need(args: string[], usage: string): string {
  if (!args[0]) {
    console.error(`usage: autocraft-server repos ${usage}`);
    process.exit(1);
  }
  return args[0];
}

const sub: Record<string, (args: string[]) => Promise<void | Promise<void>>> = {
  list,
  track: async (a) => {
    const name = need(a, "track <name | owner/name>");
    return trackRepoChecked(await openDb(), "cli", name).then((added) => {
      console.log(added ? `tracking ${name}; it syncs at the next sync` : `${name} was already tracked`);
    }, (e) => {
      if (!(e instanceof RepoError)) throw e;
      console.error(e.message);
      process.exit(1);
    });
  },
  untrack: async (a) => {
    const name = need(a, "untrack <name>");
    console.log(await untrackRepo(await openDb(), "cli", name) ? `untracked ${name}; its rows stay in the mirror (repos purge ${name} deletes them)` : `${name} was not tracked`);
  },
  pipeline: async (a) => {
    const usage = "pipeline <name> on|off";
    const name = need(a, usage);
    if (a[1] !== "on" && a[1] !== "off") { need([], usage); return; }
    try {
      const on = a[1] === "on";
      console.log(await setRepoPipeline(await openDb(), "cli", name, on) ? `${name}: pipeline ${a[1]}` : `${name}: pipeline was already ${a[1]}`);
    } catch (e) {
      if (!(e instanceof PilotError)) throw e;
      console.error(e.message);
      process.exit(1);
    }
  },
  purge: async (a) => {
    const name = need(a, "purge <name>");
    try {
      const r = await purgeRepo(await openDb(), name);
      console.log(`deleted ${r.items} items and ${r.comments} comments of ${name}`);
    } catch (e) {
      if (!(e instanceof RepoError)) throw e;
      console.error(e.message);
      process.exit(1);
    }
  },
};

export const commands = {
  identity: {
    summary: "identity [box|app]: show or set whose GitHub account writes and dashboard sign-in use",
    run: async (args: string[]) => {
      const db = await openDb();
      if (args[0] === undefined) { console.log(await githubIdentity(db)); return; }
      try {
        let registered = false;
        registered = readAppSecrets() !== null;
        const changed = await setGithubIdentityChecked(db, "cli", args[0], { registered: () => registered });
        console.log(changed ? `identity ${args[0]} (dashboard sessions end; everyone signs in again)` : `identity was already ${args[0]}`);
      } catch (e) {
        console.error((e as Error).message);
        process.exit(1);
      }
    },
  },
  repos: {
    summary: "tracked repos: list | track <name> | untrack <name> | pipeline <name> on|off | purge <name>",
    run: async (args: string[]) => {
      const f = args[0] ? sub[args[0]] : undefined;
      if (!f) {
        console.error(`usage: autocraft-server repos ${Object.keys(sub).join("|")}`);
        process.exit(1);
      }
      return await f(args.slice(1));
    },
  },
};

/** reloadOwners() from the `repos` table, after a write to it. */
export async function reloadRepoOwners(db: Db): Promise<void> {
  await reloadOwners(() => db.all(db.k.selectFrom("main.repos").select(["name", "owner"])));
}

/** Every owner with a tracked repo, plus the default one. */
export async function trackedOwners(db: Db): Promise<string[]> {
  const rows = await db.all(db.k.selectFrom("main.tracked_repos as t").leftJoin("main.repos as r", "r.name", "t.name")
    .select((eb) => eb.fn.coalesce("r.owner", eb.val(DEFAULT_OWNER)).as("owner")).distinct());
  return [...new Set([DEFAULT_OWNER, ...rows.map((r) => r.owner)])].sort();
}
