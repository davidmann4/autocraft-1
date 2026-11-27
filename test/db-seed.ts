// The database new SQLite test databases, files and `:memory:`, start from (src/db/role.ts). A suite (scripts/test.ts) builds
// one and names it in AUTOCRAFT_TEST_DB_TEMPLATE; without it, test/db-template.ts builds one per process.
import { readFileSync } from "node:fs";
import { setNewDbSeed, type NewDbSeed } from "../src/db/role.ts";

/** Copies of the closed SQLite database at `file()`, which must return the same file each time once it returns one. */
export function seedFrom(file: () => string | undefined): NewDbSeed {
  let bytes: Uint8Array | undefined;
  return {
    file,
    bytes: () => {
      const f = file();
      if (!f || bytes) return bytes;
      bytes = readFileSync(f);
      // The file header's write and read versions: 2 is WAL, which an in-memory database cannot open.
      bytes[18] = bytes[19] = 1;
      return bytes;
    },
  };
}

/** The suite's prebuilt database, if this process runs in a suite. */
export const prebuilt = process.env.AUTOCRAFT_TEST_DB_TEMPLATE || undefined;

if (prebuilt) setNewDbSeed(seedFrom(() => prebuilt));
