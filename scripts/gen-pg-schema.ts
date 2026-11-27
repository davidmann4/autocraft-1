// Writes src/schema.pg.sql from src/schema.sql (src/db/pg-schema.ts) and, when the Postgres stamp changed, the next schema
// generation to src/db/pg-generation.ts; `--check` exits 1 when either committed file is stale.
import { readFileSync, writeFileSync } from "node:fs";
import { renderPgSchema } from "../src/db/pg-schema.ts";

const file = new URL("../src/schema.pg.sql", import.meta.url);
const genFile = new URL("../src/db/pg-generation.ts", import.meta.url);
const want = renderPgSchema();
const check = process.argv.includes("--check");
if (check) {
  let have = "";
  try {
    have = readFileSync(file, "utf8");
  } catch {
    // missing counts as stale
  }
  if (have !== want) {
    console.error("src/schema.pg.sql is stale: run `pnpm pg-schema`");
    process.exit(1);
  }
} else writeFileSync(file, want);

// Imported after the schema file is written: the stamp covers it.
await import("../src/trigger-sources.ts");
const { pgStamp } = await import("../src/db/pg-triggers.ts");
const { PG_SCHEMA_GENERATION } = await import("../src/db/pg-generation.ts");
const stamp = pgStamp();
if (PG_SCHEMA_GENERATION.stamp !== stamp) {
  if (check) {
    console.error("src/db/pg-generation.ts is stale: run `pnpm pg-schema`");
    process.exit(1);
  }
  const head = readFileSync(genFile, "utf8").split("\n")[0];
  writeFileSync(genFile, `${head}\nexport const PG_SCHEMA_GENERATION = { generation: ${PG_SCHEMA_GENERATION.generation + 1}, stamp: "${stamp}" };\n`);
}
