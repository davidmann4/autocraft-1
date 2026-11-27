// Per-repo list of optional checks, set by an operator: checks whose failure does not stop a merge, make main red
// or count as a failure to fix. Exact check names. Every other check must still be green.
import { REPO_SETTINGS, listSettings, loadTrackedRepos, saveSettings, setting, settingKey } from "./data/control/index.ts";
import { loadCheckSamples } from "./data/mirror/index.ts";
import type { Db } from "./db/index.ts";
import { openDb } from "./db/open.ts";

const def = REPO_SETTINGS.optionalChecks;
const key = (repo: string) => settingKey(def.name, repo);
const parseList = (value: string | undefined): string[] => def.read(value) as string[];

export async function optionalChecks(db: Db, repo: string): Promise<string[]> {
  return parseList(await setting(db, key(repo)));
}

/** optionalChecks() of every repo, read in one query. */
export async function optionalChecksOf(db: Db): Promise<(repo: string) => string[]> {
  const rows = new Map((await listSettings(db, { scope: "repo" })).filter((r) => r.def === def && r.repo !== null).map((r) => [key(r.repo!), r.value ?? undefined]));
  return (repo) => parseList(rows.get(key(repo)));
}

/** Returns false when nothing changed. */
export async function setOptionalCheck(db: Db, by: string, repo: string, name: string, on: boolean): Promise<boolean> {
  const check = name.trim();
  if (!check) throw new Error("the check name is empty");
  if (!(await loadTrackedRepos(db, [repo])).has(repo)) throw new Error(`${repo} is not tracked`);
  const cur = await optionalChecks(db, repo);
  if (cur.includes(check) === on) return false;
  const names = on ? [...cur, check] : cur.filter((c) => c !== check);
  await saveSettings(db, [{ key: def.name, repo, value: names.length ? JSON.stringify(names) : null }], by,
    { action: on ? "optional-check-add" : "optional-check-remove", target: repo, details: { check } });
  return true;
}

/** Check names seen on each repo's recent PRs and default-branch heads, for the add control. */
export async function seenChecksOf(db: Db, repos: string[]): Promise<Map<string, string[]>> {
  return new Map([...await loadCheckSamples(db, repos)].map(([repo, seen]) => [repo, [...new Set([...seen.pr, ...seen.main])].sort()]));
}

export const seenChecks = async (db: Db, repo: string): Promise<string[]> => (await seenChecksOf(db, [repo])).get(repo) ?? [];

export const commands = {
  "optional-checks": {
    summary: "optional-checks [--repo R] | add R NAME | remove R NAME: the checks whose failure does not stop a merge",
    async run(args: string[]): Promise<void> {
      const db = await openDb();
      const [verb, repo, ...rest] = args;
      if (verb === "add" || verb === "remove") {
        const name = rest.join(" ");
        if (!repo || !name) { console.error("usage: autocraft-server optional-checks add|remove REPO NAME"); process.exit(2); }
        try {
          const changed = await setOptionalCheck(db, "cli", repo, name, verb === "add");
          console.log(changed ? `${repo}: ${verb === "add" ? "added" : "removed"} ${name}` : `${repo}: ${name} was ${verb === "add" ? "already" : "not"} listed`);
        } catch (e) {
          console.error((e as Error).message);
          process.exit(1);
        }
        return;
      }
      const only = verb === "--repo" ? repo : undefined;
      if (verb && !only) { console.error("usage: autocraft-server optional-checks [--repo R] | add R NAME | remove R NAME"); process.exit(2); }
      const repos = [...(await loadTrackedRepos(db)).keys()].filter((r) => !only || r === only);
      for (const r of repos) {
        const list = await optionalChecks(db, r);
        if (list.length || only) console.log(`${r}: ${list.length ? list.join("; ") : "none"}`);
      }
    },
  },
};
