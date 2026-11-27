# Contributing to AutoCraft

## Project Structure

AutoCraft uses a TypeScript backend with a SQLite database and a separate web frontend. Refer to the [README](README.md) for setup, [pipeline documentation](docs/pipeline.md) for stage details, and [operations](docs/operations.md) for running the service.

Key directories:
- `src/cli.ts`: CLI entry point.
- `src/runner/`: Pipeline execution.
- `src/stages/registry.ts`: Stage definitions.
- `src/github/write.ts`: GitHub API writes.
- `src/dash/` and `web/`: Dashboard and frontend.
- `test/`: Test suite.

## Local Development

`package.json` declares Node >=24 and the project’s pnpm version. These commands are available:

```sh
pnpm test           # Run the test suite on SQLite (scripts/test.ts); file names after it run only those
pnpm test:pg:suite  # Run the suite on a throwaway Postgres in Docker (scripts/pg-test.sh)
pnpm test:pg        # Run only the Postgres tests
pnpm check          # TypeScript and generated-document checks
pnpm docs           # Regenerate marked documentation blocks
pnpm -C web dev     # Frontend development server with mock data; no backend integration
```

Both suites end with the slowest files and tests (`--slowest N` sets how many) and write the full output to a log file. `--concurrency N` sets how many test files run at once (default: the CPUs less two). A test file still running after `--file-timeout MIN` minutes (default 10, 0 for none) is killed with the processes it started, and the run reports it as failed and goes on. One file also runs on its own with `node --test test/<name>.test.ts`. The Postgres suite leaves out the files in `test/no-database.txt`, which open no database; a listed file that opens one fails.

To test backend integration, build the frontend without `VITE_MOCK=1` and follow the [dashboard setup](README.md#start-the-dashboard-and-add-the-first-operator). The [operations guide](docs/operations.md) explains how the backend serves the frontend build.

The documentation generator updates marked blocks in the README and `docs/pipeline.md`; it does not validate the surrounding prose.
