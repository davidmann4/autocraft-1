// The GitHub App row, its states, setup links and allowed owners (M04 access-b).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import type { AllowedOwner, AppInstallFacts, AppSealed, AppState, Login, NewSetupLink, Sealed, SetupLink } from "./types.ts";

const iso = (ms: number): string => new Date(ms).toISOString();

/** The stored App with its sealed keys; null when no row exists or its keys were cleared. */
export async function loadAppSealed(db: Db): Promise<AppSealed | null> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("github_app").select(["app_id", "slug", "keys_enc"]).where("id", "=", 1));
  return r?.keys_enc ? { appId: Number(r.app_id), slug: r.slug ?? "", sealed: r.keys_enc as Sealed } : null;
}

/** Whether an App with keys is stored. */
export async function hasStoredApp(db: Db): Promise<boolean> {
  const q = queryDb(db);
  return !!await q.get(q.k.selectFrom("github_app").select("id").where("id", "=", 1).where("keys_enc", "is not", null));
}

/** The app bot login (`<slug>[bot]`), read by process entry points so `src/db/open.ts` reads no domain table. */
export async function loadGithubAppLogin(db: Db): Promise<string | null> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("github_app").select("slug").where("id", "=", 1).where("keys_enc", "is not", null));
  return r?.slug ? `${r.slug}[bot]` : null;
}

/**
 * Read model for the identity health checks, two statements in one wave. `installations` counts the allowed owners whose GitHub
 * account id is known, that is, the installations the app has been seen on.
 */
export async function loadAppInstallFacts(db: Db): Promise<AppInstallFacts> {
  const q = queryDb(db);
  const [app, owners] = await db.together(() => Promise.all([
    q.get(q.k.selectFrom("github_app").select("id").where("id", "=", 1).where("keys_enc", "is not", null)),
    q.get(q.k.selectFrom("app_allowed_owners").select((eb) => [eb.fn.countAll<number>().as("owners"), eb.fn.count<number>("account_id").as("withAccount")])),
  ]));
  return { app: !!app, installations: Number(owners?.withAccount ?? 0), allowedOwners: Number(owners?.owners ?? 0) };
}

const appRow = (row: { appId: number; slug: string; sealed: Sealed }, now: string) => ({ id: 1, app_id: String(row.appId), slug: row.slug, keys_enc: row.sealed, updated_at: now });

/** Inserts the App when no row exists (a cleared row counts as existing, so a secrets file is not imported again). */
export async function importAppIfAbsent(db: Db, row: { appId: number; slug: string; sealed: Sealed }): Promise<boolean> {
  const q = queryDb(db);
  return Number((await q.run(q.k.insertInto("github_app").values(appRow(row, iso(Date.now()))).onConflict((oc) => oc.column("id").doNothing()))).changes) > 0;
}

/**
 * Stores a newly registered App when the row holds no keys, or only keys equal to `replaceUnreadable` (sealed under another
 * session key). One statement: false when another App is registered.
 */
export async function saveApp(db: Db, row: { appId: number; slug: string; sealed: Sealed }, o: { replaceUnreadable: Sealed | null }): Promise<boolean> {
  const q = queryDb(db);
  const values = appRow(row, iso(Date.now()));
  return Number((await q.run(q.k.insertInto("github_app").values(values).onConflict((oc) => oc.column("id").doUpdateSet(values)
    .where((eb) => o.replaceUnreadable === null ? eb("github_app.keys_enc", "is", null) : eb.or([eb("github_app.keys_enc", "is", null), eb("github_app.keys_enc", "=", o.replaceUnreadable)]))))).changes) > 0;
}

/** Forgets the App's keys; the row stays, so the secrets file's keys are not imported again. */
export async function clearApp(db: Db): Promise<void> {
  const q = queryDb(db);
  const blank = { app_id: null, slug: null, keys_enc: null, updated_at: iso(Date.now()) };
  await q.run(q.k.insertInto("github_app").values({ id: 1, ...blank }).onConflict((oc) => oc.column("id").doUpdateSet(blank)));
}

/** Replaces the sealed keys (the webhook secret changed) of the stored App `appId`. */
export async function swapAppWebhook(db: Db, appId: number, sealed: Sealed): Promise<boolean> {
  const q = queryDb(db);
  return Number((await q.run(q.k.updateTable("github_app").set({ keys_enc: sealed, updated_at: iso(Date.now()) })
    .where("id", "=", 1).where("app_id", "=", String(appId)).where("keys_enc", "is not", null))).changes) === 1;
}

/** Deletes stale or same-tag rows then inserts; one `db.write`. */
export async function addAppState(db: Db, row: { state: string; login: Login; sessionHash: string; createdAt: string }, o: { expireBefore: string; replaceTag?: string }): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    await q.run(q.k.deleteFrom("github_app_states").where((eb) => o.replaceTag === undefined
      ? eb("created_at", "<=", o.expireBefore) : eb.or([eb("created_at", "<=", o.expireBefore), eb("session_hash", "=", o.replaceTag)])));
    await q.run(q.k.insertInto("github_app_states").values({ state: row.state, login: row.login, session_hash: row.sessionHash, created_at: row.createdAt }));
  });
}

/** Reads a state. */
export async function loadAppState(db: Db, state: string): Promise<AppState | null> {
  const q = queryDb(db);
  return (await q.get(q.k.selectFrom("github_app_states").select(kx.cols("github_app_states")).where("state", "=", state))) ?? null;
}

/** `DELETE ... RETURNING`: of two callbacks with the same state, one gets the row. */
export async function takeAppState(db: Db, state: string): Promise<AppState | null> {
  const q = queryDb(db);
  return (await q.get(q.k.deleteFrom("github_app_states").where("state", "=", state).returning(kx.cols("github_app_states")))) ?? null;
}

/** Deletes every state. */
export async function clearAppStates(db: Db): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.deleteFrom("github_app_states"));
}

/** Inserts a setup link. */
export async function createSetupLink(db: Db, row: NewSetupLink): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.insertInto("github_setup_links").values(row));
}

/** `UPDATE ... RETURNING org` on a link neither revoked nor used. */
export async function revokeSetupLink(db: Db, id: string): Promise<{ org: string | null } | null> {
  const q = queryDb(db);
  return (await q.get(q.k.updateTable("github_setup_links").set({ revoked_at: iso(Date.now()) })
    .where("id", "=", id).where("revoked_at", "is", null).where("used_at", "is", null).returning("org"))) ?? null;
}

const creatorIsOperator = (db: Db, eb: kx.Eb) => eb.exists(eb.selectFrom("access as a").select(eb.lit(1).as("one"))
  .where(kx.ciEq(db, "a.login", "github_setup_links.created_by")).where("a.role", "=", "operator"));

const openLinks = (db: Db, now: string) => queryDb(db).k.selectFrom("github_setup_links").select(kx.cols("github_setup_links"))
  .where("revoked_at", "is", null).where("used_at", "is", null).where("expires_at", ">", now).where((eb) => creatorIsOperator(db, eb));

/** Open links whose creator is still an operator, newest first. */
export async function listOpenSetupLinks(db: Db, now: string): Promise<SetupLink[]> {
  return await queryDb(db).all(openLinks(db, now).orderBy("created_at", "desc"));
}

/** One open link. */
export async function loadOpenSetupLink(db: Db, by: { id: string } | { hash: string }, now: string): Promise<SetupLink | null> {
  return (await queryDb(db).get("id" in by ? openLinks(db, now).where("id", "=", by.id) : openLinks(db, now).where("hash", "=", by.hash))) ?? null;
}

/** Marks a link used. */
export async function useSetupLink(db: Db, id: string, by: Login, installationId: number, now: string): Promise<boolean> {
  const q = queryDb(db);
  return Number((await q.run(q.k.updateTable("github_setup_links").set({ used_at: now, used_by: by, installation_id: installationId }).where("id", "=", id))).changes) > 0;
}

/** Ends a person's open links by revoking them; returns how many. */
export async function endSetupLinksOf(db: Db, login: Login, now: string): Promise<number> {
  const q = queryDb(db);
  return Number((await q.run(q.k.updateTable("github_setup_links").set({ revoked_at: now })
    .where((eb) => kx.ciEq(db, "created_by", eb.val(login))).where("revoked_at", "is", null).where("used_at", "is", null))).changes);
}

/** Every allowed owner by login. */
export async function listAllowedOwners(db: Db): Promise<AllowedOwner[]> {
  const q = queryDb(db);
  return await q.all(q.k.selectFrom("app_allowed_owners").select(kx.cols("app_allowed_owners")).orderBy("login"));
}

/** Batched insert on conflict do nothing, returning the inserted rows; the caller audits them. */
export async function addAllowedOwners(db: Db, rows: { login: string; accountId?: number | null }[], by: string): Promise<{ inserted: AllowedOwner[] }> {
  if (rows.length === 0) return { inserted: [] };
  const q = queryDb(db);
  const at = iso(Date.now());
  const inserted: AllowedOwner[] = [];
  for (const b of kx.batches(rows)) {
    inserted.push(...await q.all(q.k.insertInto("app_allowed_owners")
      .values(b.map((r) => ({ login: r.login, account_id: r.accountId ?? null, added_by: by, added_at: at })))
      .onConflict((oc) => oc.doNothing()).returning(kx.cols("app_allowed_owners"))));
  }
  return { inserted };
}

/** Deletes one owner. */
export async function removeAllowedOwner(db: Db, login: string): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.deleteFrom("app_allowed_owners").where("login", "=", login));
}

/** Fills the account id of owners that have none: one `UPDATE ... FROM`, rows that have an id are left as they are. */
export async function setAllowedOwnerAccounts(db: Db, rows: { login: string; accountId: number }[]): Promise<void> {
  if (rows.length === 0) return;
  const k = queryDb(db).k as any;
  for (const b of kx.chunks(rows)) {
    await queryDb(db).run(k.updateTable("app_allowed_owners")
      .from(kx.valuesTable(db, b.map((r) => ({ login: r.login, account_id: r.accountId })), { login: "citext", account_id: "bigint" }, "v"))
      .set((eb: any) => ({ account_id: eb.ref("v.account_id") }))
      .where((eb: any) => eb.and([eb("app_allowed_owners.login", "=", eb.ref("v.login")), eb("app_allowed_owners.account_id", "is", null)])));
  }
}

/** Renames an owner (the installation's spelling) from `from` to `inst`. */
export async function renameAllowedOwner(db: Db, from: string, inst: string, o: { accountId?: number | null } = {}): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.updateTable("app_allowed_owners").set(o.accountId === undefined ? { login: inst } : { login: inst, account_id: o.accountId }).where("login", "=", from));
}
