// What started work needs to write in a test: the GitHub App identity, its people's access to the repo, and the app lane.
import type { Db } from "../src/db/index.ts";
import { queryDb } from "../src/db/query-db.ts";
import type { Writer } from "../src/github/write.ts";
import type { Querier } from "../src/mirror.ts";

/** The app identity, and the people who may act on the repo: write permission on it, read just now. */
export async function acting(db: Db, logins: readonly string[], repo = "app"): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.insertInto("settings").values({ key: "github_identity", value: "app" }).onConflict((oc) => oc.column("key").doUpdateSet({ value: "app" })));
  const checked_at = new Date().toISOString();
  for (const login of logins) {
    await q.run(q.k.insertInto("access").values({ login, role: "maintainer" }).onConflict((oc) => oc.doNothing()));
    await q.run(q.k.insertInto("repo_permissions").values({ login, repo, permission: "write", checked_at }).onConflict((oc) => oc.columns(["login", "repo"]).doUpdateSet({ permission: "write", checked_at })));
  }
}

/** The app lane's token and client: GraphQL goes to `querier`. */
export const appLane = (querier: Pick<Querier, "query">): Pick<Writer, "mint" | "appClient"> => ({ mint: async () => "installation-token", appClient: () => querier });
