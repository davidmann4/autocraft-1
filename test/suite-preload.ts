// Loaded with `--import` in every test process of a suite (scripts/test.ts), and on Postgres in the processes those spawn too.
// It loads no schema module: the schema modules read environment variables on import that a test file sets first.
import "./db-seed.ts";
import { guardNoDatabase } from "./no-database.ts";
import { install } from "./pg-suite.ts";

install();
guardNoDatabase();
