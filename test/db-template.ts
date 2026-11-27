// New SQLite test databases start as copies of one migrated database (test/db-seed.ts), so each opens on the up-to-date path:
// the suite's prebuilt one, or else one built in the scratch directory with the first database of the process. Tests that
// exercise migrations create their old-schema file first and are not affected.
import { createRequire } from "node:module";
import { join } from "node:path";
import { setNewDbSeed } from "../src/db/role.ts";
import { prebuilt, seedFrom } from "./db-seed.ts";
import { SCRATCH } from "./scratch.ts";

/** Builds the template database at `file`: migrated, empty, and folded out of its WAL, so the file is the whole database. */
export function buildTemplate(file: string): void {
  // Loaded here, not imported: only a process that opens a database needs the schema modules.
  const { connect } = createRequire(import.meta.url)("../src/db.ts") as typeof import("../src/db.ts");
  const db = connect(file);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}

let template: string | undefined;
let building = false;

if (!prebuilt) setNewDbSeed(seedFrom(() => {
  if (building) return undefined;
  if (!template) {
    building = true;
    try {
      const file = join(SCRATCH, "template.db");
      buildTemplate(file);
      template = file;
    } finally {
      building = false;
    }
  }
  return template;
}));
