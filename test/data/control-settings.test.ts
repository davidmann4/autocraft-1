// The settings snapshot reads the table once whatever the number of keys read, and the registry declares every key the code reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REGISTRY, RETIRED_SETTINGS, STATE_SETTINGS, SETTINGS, config, setting, withConfig } from "../../src/data/control/index.ts";
import { expectFlat } from "../helpers/query-count.ts";
import { world } from "../world-db.ts";

test("a snapshot read costs one statement however many keys are read", async () => {
  const { db } = await world();
  const props = Object.keys(SETTINGS) as (keyof typeof SETTINGS)[];
  const keys = [...new Set(REGISTRY.filter((d) => d.scope === "instance").map((d) => d.name))];
  const { large } = await expectFlat(async (n) => ({
    db,
    run: () => withConfig(db, async () => {
      for (let i = 0; i < n; i++) {
        void (config(db) as unknown as Record<string, unknown>)[props[i % props.length]!];
        await setting(db, keys[i % keys.length]!);
      }
    }),
  }), 1, 200);
  assert.equal(large.statements, 1);
});

const SRC = new URL("../../src", import.meta.url).pathname;
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);
const base = (k: string): string => k.split(":")[0]!;

/** Keys of `user_settings` (per person, owned by the runners module) and values of other lookups that look like setting keys. */
const NOT_SETTINGS = new Set(["interactive_slots", "task_items", "repos", "reserve_five_hour", "reserve_weekly", "max_calls", "manual_only", "skip_tasks", "runner_private", "ui_v2", "cwk", "cwp", "allowlist", "placement", "status", "outside-surge"]);

test("every settings key the code reads or writes is in the registry, or listed as retired or as state", () => {
  const declared = new Set([...REGISTRY.map((d) => base(d.name)), ...RETIRED_SETTINGS, ...STATE_SETTINGS.map(base)]);
  const found = new Map<string, string>();
  const note = (key: string, file: string) => { const b = base(key); if (b && !NOT_SETTINGS.has(b)) found.set(b, found.get(b) ?? file); };
  const call = /\b(?:setting|settings|settingRows|hasSetting|writeSetting|deleteSetting)\(\s*[\w.]+\s*,\s*(\[[^\]]*\]|["'`][^"'`$]+)/g;
  const decl = /\b(?:const|let)\s+[A-Za-z_]*(?:KEY|KEYS|SWEPT_AT)[A-Za-z_]*\s*=\s*["'`]([a-z][a-z0-9_:-]*)/g;
  const obj = /\bKEYS\s*=\s*\{([^}]*)\}/g;
  const where = /"key",\s*"=",\s*["'`]([a-z][a-z0-9_:-]*)/g;
  for (const f of files(SRC)) {
    if (f.endsWith("data/control/settings.ts") || f.includes("/src/db/")) continue;
    const text = readFileSync(f, "utf8");
    const file = f.slice(SRC.length + 1);
    for (const m of text.matchAll(call)) for (const lit of m[1]!.matchAll(/["'`]([a-z][a-z0-9_:-]*)/g)) note(lit[1]!, file);
    for (const m of text.matchAll(decl)) note(m[1]!, file);
    for (const m of text.matchAll(obj)) for (const lit of m[1]!.matchAll(/["']([a-z][a-z0-9_]*)["']/g)) note(lit[1]!, file);
    for (const m of text.matchAll(where)) note(m[1]!, file);
  }
  const missing = [...found].filter(([k]) => !declared.has(k)).map(([k, f]) => `${k} (${f})`);
  assert.deepEqual(missing, [], "declare these in SETTINGS/REPO_SETTINGS, or in RETIRED_SETTINGS or STATE_SETTINGS");
  assert.ok(found.size > 30, "the scan found the keys");
});
