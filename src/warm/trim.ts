// Generation pruning of a warm target. A target reused across commits keeps the artifacts of every superseded unit (a
// dependency repin leaves a whole second set of registry and git crates beside the new one), so the producer publishes
// only the units the build it just ran used.
//
// "Used" is read from the unit's fingerprint dir, `<profile>/.fingerprint/<package>-<hash>`: cargo reads the fingerprint
// of every unit in the build's graph to decide whether it is fresh, and rewrites it when it compiles the unit. That holds
// for any command, so it covers a CI gate's own warm-command, which `--message-format=json` could not. A read shows in
// the file's atime: warm-restore sets each file's atime to its mtime, and Linux (relatime or strictatime) updates an atime
// that is not newer than the mtime on the next read. warm-restore then records the build's start and whether a read on
// the target's file system updates atimes at all (`markBuildStart`); without both nothing is trimmed.
//
// A unit's artifacts carry the fingerprint dir's hash: `deps/lib<crate>-<hash>.rlib`, `deps/<crate>-<hash>`,
// `build/<package>-<hash>` (a build script's binary, or its run's OUT_DIR), `examples/<name>-<hash>`. Only entries whose
// hash belongs to a stale fingerprint dir are left out, so an artifact this trim cannot attribute is kept. Incremental
// dirs are named by rustc's crate id, not cargo's hash, and are matched by crate name.
//
// Cargo's build-dir layout (1.100) keeps each unit in one dir, `<profile>/build/<package>/<hash>/{fingerprint,out,run,...}`.
// The unit is used when its `fingerprint/` dir was read or written by this build, and an unused one is left out whole.
// A profile dir is one with `.fingerprint` or with such unit dirs; a target with neither is not trimmed or called trimmed.
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What warm-restore records for the trim: when the build started (ns, file-system clock) and whether reads update atimes there. */
export type BuildStart = { stampNs: bigint; atime: boolean };

/** One profile dir's listing (`target/debug`, `target/<triple>/release`, ...): entry names, with whether this build touched them. */
export type ProfileListing = {
  fingerprint: { name: string; touched: boolean }[];
  deps: string[]; build: string[]; examples: string[];
  incremental: { name: string; touched: boolean }[];
};

const HASHED = /^(.+)-([0-9a-f]{16})(?:\..*)?$/;
const hashOf = (name: string): string | null => HASHED.exec(name)?.[2] ?? null;
const SUBDIRS = ["deps", "build", "examples"] as const;

/**
 * The entries of one profile dir that belong to units this build did not use, as paths relative to the profile dir, and
 * how many units that is. Fingerprint dirs this build did not touch are the stale units; deps, build and examples entries
 * go with them by hash. An incremental dir goes when no used unit has its crate name, or when another dir of that crate
 * name was compiled this build and it was not.
 */
export function staleEntries(l: ProfileListing): { paths: string[]; units: number } {
  const stale = new Set<string>();
  const used = new Set<string>();
  const paths: string[] = [];
  for (const f of l.fingerprint) {
    const h = hashOf(f.name);
    if (!h) continue;
    if (f.touched) used.add(h);
    else {
      stale.add(h);
      paths.push(`.fingerprint/${f.name}`);
    }
  }
  const crates = new Set<string>();
  for (const sub of SUBDIRS) {
    for (const name of l[sub]) {
      const h = hashOf(name);
      if (!h) continue;
      if (stale.has(h)) paths.push(`${sub}/${name}`);
      else if (used.has(h)) {
        const crate = HASHED.exec(name)![1];
        crates.add(crate).add(crate.replace(/^lib/, ""));
        if (sub === "build") crates.add("build_script_*");
      }
    }
  }
  const crateOf = (name: string) => name.slice(0, name.lastIndexOf("-"));
  const known = (c: string) => crates.has(c) || (c.startsWith("build_script_") && crates.has("build_script_*"));
  const compiled = new Set(l.incremental.filter((d) => d.touched).map((d) => crateOf(d.name)));
  for (const d of l.incremental) {
    if (!d.name.includes("-") || d.touched) continue;
    const c = crateOf(d.name);
    if (!known(c) || compiled.has(c)) paths.push(`incremental/${d.name}`);
  }
  return { paths, units: stale.size };
}

/** `<package>/<hash>` unit dirs of a profile's `build/` in the one-dir-per-unit layout, with whether this build used them. */
export type UnitDir = { pkg: string; hash: string; touched: boolean };

/** The unit dirs of the one-dir-per-unit layout that this build did not use, as paths relative to the profile dir; a package dir left empty goes too. */
export function staleUnitDirs(units: UnitDir[]): { paths: string[]; units: number } {
  const byPkg = new Map<string, UnitDir[]>();
  for (const u of units) byPkg.set(u.pkg, [...(byPkg.get(u.pkg) ?? []), u]);
  const paths: string[] = [];
  let n = 0;
  for (const [pkg, list] of byPkg) {
    const stale = list.filter((u) => !u.touched);
    n += stale.length;
    if (stale.length === list.length) paths.push(`build/${pkg}`);
    else for (const u of stale) paths.push(`build/${pkg}/${u.hash}`);
  }
  return { paths, units: n };
}

/**
 * Probes the target's file system, then writes `file`: the start stamp (the probe's ctime, set after every restored
 * file's times) and whether a read updated the probe's atime. Run after the restore and before the build.
 */
export function markBuildStart(target: string, file: string): BuildStart {
  const probe = join(target, `.autocraft-atime-probe-${process.pid}`);
  writeFileSync(probe, "x");
  try {
    utimesSync(probe, 1_000_000_000, 1_000_000_000);
    const fd = openSync(probe, "r");
    try {
      readSync(fd, Buffer.alloc(1), 0, 1, 0);
    } finally {
      closeSync(fd);
    }
    const st = lstatSync(probe, { bigint: true });
    const start = { stampNs: st.ctimeNs, atime: st.atimeNs > st.mtimeNs };
    writeFileSync(file, JSON.stringify({ stampNs: String(start.stampNs), atime: start.atime }));
    return start;
  } finally {
    unlinkSync(probe);
  }
}

export function readBuildStart(file: string | undefined): BuildStart | null {
  try {
    const o = JSON.parse(readFileSync(file!, "utf8")) as { stampNs?: unknown; atime?: unknown };
    return typeof o.stampNs === "string" && /^\d+$/.test(o.stampNs) && typeof o.atime === "boolean" ? { stampNs: BigInt(o.stampNs), atime: o.atime } : null;
  } catch {
    return null;
  }
}

const isDir = (p: string) => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};
const names = (p: string) => (isDir(p) ? readdirSync(p) : []);

/** Bytes of the files under `p` (no links followed). */
function bytesOf(p: string): number {
  const st = lstatSync(p, { throwIfNoEntry: false });
  if (!st) return 0;
  if (!st.isDirectory()) return st.isFile() ? st.size : 0;
  return readdirSync(p).reduce((n, c) => n + bytesOf(join(p, c)), 0);
}

/**
 * The stale entries of every profile dir under `target` (a dir with a `.fingerprint` child or with `build/<package>/<hash>/fingerprint`
 * unit dirs, at depth 1 or 2), as paths
 * relative to `target`, with the units and bytes they hold. `unattributed` counts the units kept only because a file of
 * theirs was read at some time not known to be this build (atime after mtime but before the start): such a unit may hold
 * dep-info of an older commit, so the publish is not `trimmed` (src/warm/manifest.ts) when there is one. `profiles` counts the
 * profile dirs found; with none, nothing was trimmed and the publish is not `trimmed` either.
 */
export function trimTarget(target: string, start: BuildStart): { paths: string[]; units: number; bytes: number; unattributed: number; profiles: number } {
  // 2: read or written by this build; 1: read at an unknown time; 0: not read since warm-restore set its times.
  const use = (st: { mtimeNs: bigint; atimeNs: bigint }) => (st.mtimeNs >= start.stampNs || st.atimeNs >= start.stampNs ? 2 : st.atimeNs > st.mtimeNs ? 1 : 0);
  let unattributed = 0;
  const dirTouched = (d: string, deep: boolean) => {
    const st = lstatSync(d, { bigint: true });
    if (st.mtimeNs >= start.stampNs) return true;
    if (!deep) return false;
    const files = readdirSync(d);
    // An empty fingerprint dir says nothing: keep it. It holds no dep-info, so cargo rebuilds its unit anyway.
    if (!files.length) return true;
    const level = Math.max(...files.map((f) => use(lstatSync(join(d, f), { bigint: true }))));
    if (level === 1) unattributed++;
    return level > 0;
  };
  const unitDirs = (p: string): { pkg: string; hash: string; dir: string }[] =>
    names(join(p, "build")).flatMap((pkg) => names(join(p, "build", pkg)).filter((h) => /^[0-9a-f]{16}$/.test(h) && isDir(join(p, "build", pkg, h, "fingerprint"))).map((hash) => ({ pkg, hash, dir: join(p, "build", pkg, hash) })));
  const isProfile = (p: string) => isDir(join(p, ".fingerprint")) || unitDirs(p).length > 0;
  const profiles: string[] = [];
  for (const a of names(target)) {
    const p = join(target, a);
    if (isProfile(p)) profiles.push(a);
    else for (const b of names(p)) if (isProfile(join(p, b))) profiles.push(`${a}/${b}`);
  }
  const out = { paths: [] as string[], units: 0, bytes: 0, unattributed: 0, profiles: profiles.length };
  for (const rel of profiles) {
    const p = join(target, rel);
    const per = staleUnitDirs(unitDirs(p).map((u) => ({ pkg: u.pkg, hash: u.hash, touched: dirTouched(join(u.dir, "fingerprint"), true) })));
    out.units += per.units;
    for (const x of per.paths) {
      out.paths.push(`${rel}/${x}`);
      out.bytes += bytesOf(join(p, x));
    }
    const listing: ProfileListing = {
      fingerprint: names(join(p, ".fingerprint")).map((name) => ({ name, touched: dirTouched(join(p, ".fingerprint", name), true) })),
      deps: names(join(p, "deps")), build: names(join(p, "build")), examples: names(join(p, "examples")),
      incremental: names(join(p, "incremental")).map((name) => ({ name, touched: dirTouched(join(p, "incremental", name), false) })),
    };
    const s = staleEntries(listing);
    out.units += s.units;
    for (const x of s.paths) {
      out.paths.push(`${rel}/${x}`);
      out.bytes += bytesOf(join(p, x));
    }
  }
  out.unattributed = unattributed;
  return out;
}
