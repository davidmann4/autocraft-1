// Whitelist overrides (M03 access-a). The tier policy stays in src/whitelist.ts over these loaders.
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { addAudit } from "../control/audit.ts";
import type { Login, Override, OverrideRow } from "./types.ts";

const toOverride = (r: OverrideRow): Override => ({ login: r.login, status: r.status, githubId: r.github_id === null ? null : Number(r.github_id), note: r.note, by: r.by, at: r.at });

/** Overrides by lower-cased login; `"all"` is the explicit whole-table form. */
export async function loadOverrides(db: Db, logins: Login[] | "all"): Promise<Map<string, Override>> {
  const out = new Map<string, Override>();
  if (logins !== "all" && !logins.length) return out;
  const q = queryDb(db);
  const parts = logins === "all" ? [null] : kx.chunks([...new Set(logins.map((l) => l.toLowerCase()))]);
  for (const part of parts) {
    const rows = await q.all(q.k.selectFrom("main.whitelist_overrides").select(["login", "status", "note", "by", "at", "github_id"])
      .$if(part !== null, (b) => b.where(kx.inList(db, q.k.fn("lower", ["login"]), part!))));
    for (const r of rows) out.set(r.login.toLowerCase(), toOverride(r));
  }
  return out;
}

/** Every override, for the Contributors page. */
export async function listOverrides(db: Db): Promise<OverrideRow[]> {
  const q = queryDb(db);
  return await q.all(q.k.selectFrom("main.whitelist_overrides").select(["login", "status", "note", "by", "at", "github_id"]).orderBy(kx.nocase(db, "login")));
}

/** Deletes the same login in another case, upserts, audits; one `db.write`. */
export async function saveOverride(db: Db, row: { login: Login; status: string; githubId?: number | null; note?: string | null }, by: string): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    const at = new Date().toISOString();
    await q.run(q.k.deleteFrom("main.whitelist_overrides").where((eb) => kx.ciEq(db, "login", eb.val(row.login))).where("login", "<>", row.login));
    await q.run(q.k.insertInto("main.whitelist_overrides").values({ login: row.login, status: row.status, note: row.note || null, by, at, github_id: row.githubId ?? null })
      .onConflict((oc) => oc.column("login").doUpdateSet(kx.excluded(["status", "note", "by", "at", "github_id"]))));
    // The note is private: the audit row records only that one was given.
    await addAudit(db, [{ login: by, action: "override", target: row.login, details: { status: row.status, note: row.note ? true : undefined, githubId: row.githubId ?? undefined }, at }]);
  });
}

/** Deletes and audits; one `db.write`. */
export async function clearOverride(db: Db, login: Login, by: string): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    await q.run(q.k.deleteFrom("main.whitelist_overrides").where((eb) => kx.ciEq(db, "login", eb.val(login))));
    await addAudit(db, [{ login: by, action: "override", target: login, details: { status: "clear" } }]);
  });
}
