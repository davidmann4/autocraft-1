// What the maintainer workflow left behind, and its removal in the release after the one that switched (src/db/switch-over.ts).
//
// The removal is off: releases before the switch still read these tables, columns and settings rows, and a rollback needs
// them. DROP_RETIRED turns it on, with `pnpm pg-schema` and `pnpm db-types` run after it (the scoped view of `decisions` goes).
// The runner then runs dropRetired at its start, after the switch. It archives what is not archived yet and drops what is
// still there, so it may be cut short and run again, and it drops again what a later schema migration made anew while
// src/schema.sql still defines it. After it a rollback needs a restore.
import type { DatabaseSync } from "node:sqlite";
import type { Db } from "./index.ts";
import { liveSql } from "./live.ts";
import { dbTarget, isPgUrl, loadPg } from "./open.ts";
import { planChangesSql } from "./plan-triggers.ts";
import { PIN_SEARCH_PATH, withMigrationLock, readCatalog, type MigrationOpts, type PgClient } from "./pg-migrate.ts";
import { PG_COLUMNS_SQL, pgColumns, pgTriggerParts } from "./pg-triggers.ts";
import { pgConnectionString } from "./postgres.ts";
import { queryDb } from "./query-db.ts";
import { pgScopeViews, SCOPED_SCHEMA } from "./scoped.ts";
import { COPIED_SETTINGS } from "./state-copy.ts";
import { archiveActions, archiveDecisions, SWITCH_KEY, type SwitchReport } from "./switch-over.ts";
import { DROP_RETIRED, RETIRED_COLUMNS, RETIRED_TABLES } from "./retired-names.ts";

/** Tables keyed by a retired column: the key they get, and the rows that have none go with it. */
const REKEYED: Record<string, { key: string[]; withoutRowid?: boolean }> = {
  dupe_groups: { key: ["id"] },
  dupe_group_items: { key: ["group_id", "number"] },
  discord_alert_msgs: { key: ["user_hash", "workflow_id", "rec_at"], withoutRowid: true },
};

/** Settings rows: the state that moved to tables, and what nothing reads. */
const SETTING_KEYS = [...COPIED_SETTINGS.keys, "flow_summary_marks", "pilot_items", "outside_admitted_backfill", "usage_pause", "inference", "judgement_model", "maintainer_writes"];
const SETTING_PREFIXES = [...COPIED_SETTINGS.prefixes, "fixissue_not_rust:"];

/** The retired columns `have` ("table.column") still has, per table. */
function columnsLeft(has: (column: string) => boolean): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [t, c] of RETIRED_COLUMNS) if (has(`${t}.${c}`)) out.set(t, [...(out.get(t) ?? []), c]);
  return out;
}

/**
 * Archives what is left of the decision system and drops the retired tables, columns and settings rows. Does nothing while
 * DROP_RETIRED is off (`force` is for tests), before the switch, or once nothing is left. Returns what it dropped.
 */
export async function dropRetired(db: Db, o: { force?: boolean; target?: string; now?: string } & MigrationOpts = {}): Promise<string[]> {
  if (!DROP_RETIRED && !o.force) return [];
  const q = queryDb(db), k = q.k as any;
  const marker = (await q.get(k.selectFrom("main.settings").select("value").where("key", "=", SWITCH_KEY))) as { value: string } | undefined;
  if (!marker) return [];
  const now = o.now ?? new Date().toISOString();
  const sweep = async (left: Set<string>): Promise<void> => {
    const r: Pick<SwitchReport, "archived"> = { archived: { answered: 0, withdrawn: 0, actions: 0, withoutItem: 0 } };
    // `decisions` goes last, so while it is there nothing it explains is lost.
    if (left.has("decisions") && left.has("actions")) await archiveActions(db, r);
    if (left.has("decisions")) await archiveDecisions(db, r, now, true);
  };
  let dropped: string[];
  if (db.dialect === "sqlite") {
    const sync = q.sync!;
    const tables = sqliteTables(sync);
    await sweep(new Set(RETIRED_TABLES.filter((t) => tables.has(t))));
    dropped = dropSqlite(sync);
  } else {
    const target = o.target ?? dbTarget();
    if (!isPgUrl(target)) throw new Error("dropRetired: no Postgres URL");
    const pg = await loadPg();
    const client = new pg.Client({ connectionString: pgConnectionString(target), application_name: "autocraft-migrate" });
    await client.connect();
    try {
      const cat = await readCatalog(client as PgClient);
      await sweep(new Set(RETIRED_TABLES.filter((t) => cat.tables.has(t))));
      dropped = await dropPg(client as PgClient, o);
    } finally {
      await client.end();
    }
  }
  await db.write(async () => {
    const w = q.k as any;
    await q.run(w.deleteFrom("main.settings").where((eb: any) => eb.or([eb("key", "in", SETTING_KEYS),
      ...SETTING_PREFIXES.map((p) => eb(eb.fn("substr", ["key", eb.lit(1), eb.lit(p.length)]), "=", p))])));
    // The older release took "started" for all items, so the value is renamed only now; the reader takes both (src/data/runners/user-settings.ts).
    await q.run(w.updateTable("main.user_settings").set({ value: "started", updated_at: now }).where("key", "=", "task_items").where("value", "=", "fast"));
    // The older runner's heartbeat is gone with the rest, and no older release can run again: the switch stays done.
    const at = (JSON.parse(marker.value) as { at?: string }).at ?? now;
    await q.run(w.updateTable("main.settings").set({ value: JSON.stringify({ at, heartbeat: null }) }).where("key", "=", SWITCH_KEY));
    if (dropped.length) await q.run(w.insertInto("main.audit").values({ at: now, login: "pipeline", action: "retired-drop", target: null, details: JSON.stringify({ dropped }) }));
  });
  return dropped;
}

// ---- SQLite -----------------------------------------------------------------------------------------------------------

const sqliteTables = (db: DatabaseSync): Set<string> =>
  new Set((db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));

type Info = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
const word = (text: string, name: string): boolean => new RegExp(`\\b${name}\\b`, "i").test(text);

/** One transaction: the live and change-log triggers go first, since they name every column, and come back last. */
function dropSqlite(db: DatabaseSync): string[] {
  const info = (t: string): Info[] => db.prepare(`PRAGMA main.table_info(${t})`).all() as unknown as Info[];
  const tables = sqliteTables(db);
  const left = columnsLeft((x) => {
    const [t, c] = x.split(".") as [string, string];
    return tables.has(t) && info(t).some((i) => i.name === c);
  });
  const gone = RETIRED_TABLES.filter((t) => tables.has(t));
  if (!left.size && !gone.length) return [];
  const out: string[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const t of db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'trigger' AND (name LIKE 'live\\_%' ESCAPE '\\' OR name LIKE 'plan\\_%' ESCAPE '\\')").all() as { name: string }[]) db.exec(`DROP TRIGGER main.${t.name}`);
    // No ALTER TABLE ... RENAME: it would check every trigger and view of the schema, among them those on the table it replaces.
    for (const [t, cols] of left) {
      const indexes = db.prepare("SELECT name, sql FROM main.sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(t) as { name: string; sql: string }[];
      const stale = indexes.filter((i) => cols.some((c) => word(i.sql.slice(i.sql.indexOf("(")), c)));
      for (const i of stale) db.exec(`DROP INDEX main.${i.name}`);
      const rekey = REKEYED[t];
      if (!rekey) {
        for (const c of cols) db.exec(`ALTER TABLE main.${t} DROP COLUMN ${c}`);
      } else {
        const keep = info(t).filter((i) => !cols.includes(i.name));
        const names = keep.map((i) => i.name).join(", ");
        const defs = keep.map((i) => `${i.name} ${i.type}${i.notnull || rekey.key.includes(i.name) ? " NOT NULL" : ""}${i.dflt_value === null ? "" : ` DEFAULT ${i.dflt_value}`}`);
        db.exec(`CREATE TEMP TABLE retired_keep AS SELECT ${names} FROM main.${t} WHERE ${rekey.key.map((c) => `${c} IS NOT NULL`).join(" AND ")}`);
        db.exec(`DROP TABLE main.${t}`);
        db.exec(`CREATE TABLE main.${t} (${defs.join(", ")}, PRIMARY KEY (${rekey.key.join(", ")}))${rekey.withoutRowid ? " WITHOUT ROWID" : ""}`);
        db.exec(`INSERT OR IGNORE INTO main.${t} (${names}) SELECT ${names} FROM temp.retired_keep`);
        db.exec("DROP TABLE temp.retired_keep");
        for (const i of indexes) if (!stale.includes(i)) db.exec(i.sql);
      }
      out.push(...cols.map((c) => `${t}.${c}`));
    }
    for (const t of gone) {
      db.exec(`DROP TABLE main.${t}`);
      out.push(t);
    }
    db.exec(liveSql(db));
    db.exec(planChangesSql(db));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return out;
}

// ---- Postgres ---------------------------------------------------------------------------------------------------------

/** A step per table, each with a short lock wait that is retried (src/db/pg-migrate.ts). */
async function dropPg(client: PgClient, o: MigrationOpts): Promise<string[]> {
  return await withMigrationLock(client, async (m) => {
    const rows = async (text: string) => (await client.query(text)).rows;
    const cat = await readCatalog(client);
    const left = columnsLeft((c) => cat.columns.has(c));
    const out: string[] = [];
    const columns = pgColumns(await rows(PG_COLUMNS_SQL) as { t: string; c: string }[]);
    for (const [t, cols] of left) columns.set(t, (columns.get(t) ?? []).filter((c) => !cols.includes(c)));
    const functions = pgTriggerParts(columns).functions;
    const views = pgScopeViews((await rows("SELECT current_schema() AS s"))[0]!.s as string);
    const viewOf = (t: string) => views.find((v) => v.view === `${SCOPED_SCHEMA}.${t}`);
    for (const [t, cols] of left) {
      const view = viewOf(t);
      const rekey = REKEYED[t];
      const mine = functions.filter((f) => f.startsWith(`CREATE OR REPLACE FUNCTION ac_trg_${t}_`) && /^[iud]\(/.test(f.slice(`CREATE OR REPLACE FUNCTION ac_trg_${t}_`.length)));
      await m.step({
        label: `retired columns: ${t}`, table: t,
        sql: [
          ...(view ? [`DROP VIEW IF EXISTS ${view.view}`] : []),
          ...(rekey ? [`DELETE FROM ${t} WHERE ${rekey.key.map((c) => `${c} IS NULL`).join(" OR ")}`] : []),
          `ALTER TABLE ${t} ${cols.map((c) => `DROP COLUMN IF EXISTS ${c}`).join(", ")}`,
          ...(rekey ? [`ALTER TABLE ${t} ${rekey.key.map((c) => `ALTER COLUMN ${c} SET NOT NULL`).join(", ")}, ADD PRIMARY KEY (${rekey.key.join(", ")})`] : []),
          ...(mine.length ? [...mine, PIN_SEARCH_PATH] : []),
          ...(view ? [view.sql.replace("CREATE OR REPLACE VIEW", "CREATE VIEW")] : []),
        ],
      });
      out.push(...cols.map((c) => `${t}.${c}`));
    }
    for (const t of RETIRED_TABLES) {
      if (!cat.tables.has(t)) continue;
      await m.step({ label: `retired table: ${t}`, table: t, sql: [`DROP VIEW IF EXISTS ${SCOPED_SCHEMA}.${t}`, `DROP TABLE IF EXISTS ${t}`] });
      out.push(t);
    }
    return out;
  }, o);
}
