import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staleEntries, trimTarget } from "../src/warm/trim.ts";

test("a warm trim leaves out the units the build did not use and keeps the ones it did", () => {
  const OLD = "4c68d8e5d9da9017", NEW = "9a1b2c3d4e5f6071", RUN_OLD = "e5c8bb1780f8bd7f", RUN_NEW = "0123456789abcdef", FRESH = "0db2acf210aeb36b";
  const { paths, units } = staleEntries({
    fingerprint: [
      { name: `dep-a-${OLD}`, touched: false }, { name: `dep-a-${RUN_OLD}`, touched: false },
      { name: `dep-a-${NEW}`, touched: true }, { name: `dep-a-${RUN_NEW}`, touched: true }, { name: `my-pm-${FRESH}`, touched: true },
    ],
    deps: [`libdep_a-${OLD}.rlib`, `dep_a-${OLD}.d`, `libdep_a-${NEW}.rlib`, `libmy_pm-${FRESH}.so`, "orphan-ffffffffffffffff", "rmeta-tmp"],
    build: [`dep-a-${RUN_OLD}`, `dep-a-${RUN_NEW}`],
    examples: [],
    incremental: [
      { name: "my_pm-3ge0gnqx4rjez", touched: false }, { name: "gone-2dzz4sbo5b4lc", touched: false },
      { name: "dep_a-1aaaaaaaaaaaa", touched: true }, { name: "dep_a-2bbbbbbbbbbbb", touched: false },
    ],
  });
  const stale = new Set(paths);
  for (const p of [`.fingerprint/dep-a-${OLD}`, `.fingerprint/dep-a-${RUN_OLD}`, `deps/libdep_a-${OLD}.rlib`, `deps/dep_a-${OLD}.d`, `build/dep-a-${RUN_OLD}`, "incremental/gone-2dzz4sbo5b4lc", "incremental/dep_a-2bbbbbbbbbbbb"]) {
    assert.ok(stale.has(p), `${p} is stale`);
  }
  // Used units, a fresh crate's only incremental dir, and what no fingerprint names stay.
  for (const p of [`.fingerprint/dep-a-${NEW}`, `deps/libdep_a-${NEW}.rlib`, `deps/libmy_pm-${FRESH}.so`, `build/dep-a-${RUN_NEW}`, "deps/orphan-ffffffffffffffff", "deps/rmeta-tmp", "incremental/my_pm-3ge0gnqx4rjez", "incremental/dep_a-1aaaaaaaaaaaa"]) {
    assert.ok(!stale.has(p), `${p} is kept`);
  }
  assert.ok(units > 0);
});

test("trimTarget drops unused units in both cargo layouts and reports no profile for an empty target", () => {
  const root = mkdtempSync(join(tmpdir(), "trim-"));
  try {
    const OLD = "4c68d8e5d9da9017", NEW = "9a1b2c3d4e5f6071", K = "0123456789abcdef", S = "fedcba9876543210";
    const t = (p: string, when: number) => utimesSync(p, when, when);
    const file = (p: string, when: number) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, "x"); t(p, when); };
    const old = 978_307_200, now = Date.now() / 1000;
    // Old layout: debug/.fingerprint + deps.
    for (const [h, when] of [[OLD, old], [NEW, now]] as const) {
      file(join(root, `debug/.fingerprint/a-${h}/dep-info`), when); t(join(root, `debug/.fingerprint/a-${h}`), when);
      file(join(root, `debug/deps/liba-${h}.rlib`), when);
    }
    // New layout: x86/release/build/<pkg>/<hash>/fingerprint; pkg b has only a stale unit, c has one of each.
    for (const [pkg, h, when] of [["b", S, old], ["c", OLD, old], ["c", K, now]] as const) {
      file(join(root, `x86/release/build/${pkg}/${h}/fingerprint/dep-info`), when);
      t(join(root, `x86/release/build/${pkg}/${h}/fingerprint`), when);
      file(join(root, `x86/release/build/${pkg}/${h}/out/o.rlib`), when);
    }
    const start = { stampNs: BigInt(Math.floor((now - 3600) * 1e3)) * 1_000_000n, atime: true };
    const r = trimTarget(root, start);
    assert.equal(r.profiles, 2);
    const gone = new Set(r.paths);
    for (const p of [`debug/.fingerprint/a-${OLD}`, `debug/deps/liba-${OLD}.rlib`, "x86/release/build/b", `x86/release/build/c/${OLD}`]) assert.ok(gone.has(p), `${p} is stale`);
    for (const p of [`debug/.fingerprint/a-${NEW}`, `debug/deps/liba-${NEW}.rlib`, `x86/release/build/c/${K}`, "x86/release/build/c"]) assert.ok(!gone.has(p), `${p} is kept`);
    assert.equal(r.units, 3);
    assert.ok(r.bytes > 0);
    const empty = mkdtempSync(join(tmpdir(), "trim-empty-"));
    try { assert.equal(trimTarget(empty, start).profiles, 0); } finally { rmSync(empty, { recursive: true }); }
  } finally {
    rmSync(root, { recursive: true });
  }
});
