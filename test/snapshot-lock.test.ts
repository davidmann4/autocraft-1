// The item snapshot build lock: one build at a time across processes, released when its holder dies, and partial
// files of interrupted builds removed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { withSnapshotLock } from "../src/itemtools/snapshot.ts";

test("a build waits for another process's build, takes over when that process dies, and removes partial files", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dest = join(dir, "items.db");
  writeFileSync(dest, "");
  for (const f of ["items.db.35.tmp", "items.db.tmp", "items.db.tmp-journal", "other.tmp"]) writeFileSync(join(dir, f), "x");

  const module = new URL("../src/itemtools/snapshot.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e",
    `const { withSnapshotLock } = await import(${JSON.stringify(module)}); await withSnapshotLock(${JSON.stringify(dest)}, () => { console.log("held"); return new Promise(() => setInterval(() => {}, 1000)); });`],
  { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => child.kill("SIGKILL"));
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (b: Buffer) => { if (b.toString().includes("held")) resolve(); });
    child.on("exit", (code) => reject(new Error(`lock holder exited ${code}`)));
  });
  assert.ok(!existsSync(join(dir, "items.db.35.tmp")) && !existsSync(join(dir, "items.db.tmp")) && !existsSync(join(dir, "items.db.tmp-journal")));
  assert.ok(existsSync(dest) && existsSync(join(dir, "other.tmp")));

  writeFileSync(join(dir, "items.db.852.tmp"), "x");
  let entered = false;
  const second = withSnapshotLock(dest, async () => { entered = true; });
  await sleep(1500);
  assert.equal(entered, false);
  child.kill("SIGKILL");
  await second;
  assert.equal(entered, true);
  assert.ok(!existsSync(join(dir, "items.db.852.tmp")));
});
