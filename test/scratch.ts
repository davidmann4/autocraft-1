// Scratch space for test databases, checkouts and caches: one directory per test
// process (node --test runs each file in its own), removed when the process exits.
// It lives under ~/.cache, not /tmp: /tmp is a RAM disk shared by the whole box.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import "./db-template.ts";

const BASE = join(homedir(), ".cache/autocraft-scratch");
mkdirSync(BASE, { recursive: true });
export const SCRATCH = mkdtempSync(join(BASE, "test-"));
// Artifacts are keyed by task id, which every test database counts from 1: their files stay apart from other processes'.
process.env.AUTOCRAFT_ARTIFACT_DIR ??= join(SCRATCH, "artifacts");
process.on("exit", () => rmSync(SCRATCH, { recursive: true, force: true }));
// The diff cache defaults to one shared directory under the home: test processes running at once would read, write and
// drop (dropCachedDiff) each other's diffs for the same fixture heads (app#3@sha3). A test may still point it elsewhere.
process.env.AUTOCRAFT_DIFF_CACHE = join(SCRATCH, "diffs");
// The sandbox checkout root, its sibling `sessions` (per-call session stores) and the generated agents-*.json files, and the
// fixed model-call working directory, all default to directories under ~/.cache/autocraft. A test may still point them elsewhere.
process.env.AUTOCRAFT_CHECKOUT_DIR = join(SCRATCH, "checkouts");
process.env.AUTOCRAFT_CLAUDE_CWD = join(SCRATCH, "claude-cwd");
