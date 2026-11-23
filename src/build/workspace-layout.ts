// Workspace layout 2: a session's workspace at the CI runner's paths, so a build in it reuses its node's warm version the
// way a build pod does (src/build/warm-mount.ts). Cargo's fingerprints hold absolute paths, so the checkout, the target
// dir and CARGO_HOME sit where the warm producer built them:
//
//   /home/runner/_work/<repo>/<repo>          the checkout (volume subPath `checkout`); /work/src links to it
//   /home/runner/_work/<repo>/<repo>/target   the target dir: volume subPath `cargo-target`;
//                                             /work/target links to it
//   /cache/cargo                              CARGO_HOME (volume subPath `cache`)
//   /craft-fonts, /craft-i18n                 the CI gate's checkouts, read-only (volume subPaths under `ext/`)
//
// The pod gets the CI gate's step env at the base commit (gateEnvOf), so the warm version's CI env hash matches. Repositories
// with a warm target (build_sizes.warm_target) get layout 2; the others keep layout 1 (/work/src, /work/cargo, /work/target).
//
// A fresh volume starts warm when a node's status holds the repository's key with the workspace's image and CI env, and (for
// `pvc`) the base commit's Cargo.lock: the pod mounts that node's warm claim, which pins it there, and `warm-copy` fills the
// target and CARGO_HOME before the workspace container starts. The checkout arrives later (seeding), so its mtimes are set
// then (WARM_MTIMES_SH). A resume onto a kept volume never copies again: the target is already there. A workspace's target is
// always on its volume, whatever the repository's warm target: that only decides whether the workspace starts warm.
import { createHash } from "node:crypto";
import { OLD_MTIME_SEC } from "../worker/warm-copy.ts";
import { gateEnvOf, warmEnvHash } from "./pods.ts";
import { decideWarm, type WarmTarget, type WarmUse } from "./warm-mount.ts";
import type { ToolchainId } from "../warm/toolchain.ts";
import type { WarmNode } from "./warm-status.ts";

export const LAYOUT_CI = 2;

/** The CI gate's inputs at the workspace's base commit, as the build pods' source pod finds them (src/worker/pod.ts). */
export type WorkspacePrepared = {
  /** The gate's step env, with the craft-fonts and craft-i18n dirs (gateStepEnv). */
  env: Record<string, string>;
  craftFontsRef: string | null; craftI18nRev: string | null; cacheVersion: string | null;
  /** sha256 of the base commit's Cargo.lock; null when it has none. */
  cargoLock: string | null;
};

/** How the workspace's current volume and pod start their target. */
export type WorkspaceWarm = {
  /** The repository's warm target when the volume was made. */
  target: WarmTarget;
  /** The volume's size request. */
  storageBytes: number;
  /** The version the current pod copies; null: it starts cold, or keeps what its volume holds. */
  use: WarmUse | null;
  /** Why the target starts cold; null when it starts warm or keeps its volume's. */
  why: string | null;
  /** What the item page shows once seeding is done, and when. */
  note?: string; at?: string;
};

/** A row's `warm`, or null when it has none (layout 1) or it does not parse. */
export function warmOf(w: { warm: string | null }): WorkspaceWarm | null {
  try {
    return w.warm ? (JSON.parse(w.warm) as WorkspaceWarm) : null;
  } catch {
    return null;
  }
}

/** photocraft's target grows from its 27 GB warm size to 50-70 GB in a session (a dependency update adds a second set of units). */
export const WS_WARM_GROWTH = 2.6;
export const WS_STORAGE_HEADROOM_BYTES = 8 * 1024 ** 3;

/** The volume a workspace needs: the environment's size, or for a target on the volume room for the warm version to grow. */
export const workspaceStorageBytes = (base: number, target: WarmTarget, warmBytes: number | null): number =>
  target === "pvc" && warmBytes ? Math.max(base, Math.ceil(warmBytes * WS_WARM_GROWTH) + WS_STORAGE_HEADROOM_BYTES) : base;

/** The env hash a warm version must have been built with for this workspace (pods.ts warmEnvHash). */
export const workspaceEnvHash = (p: WorkspacePrepared): string => warmEnvHash({ env: p.env, cacheVersion: p.cacheVersion, craftFontsRef: p.craftFontsRef, craftI18nRev: p.craftI18nRev });

/** The workspace container's CI part of the env: the gate's step env at the CI paths, without its HOME (the session's home stays on the volume). */
export function ciStepEnv(p: WorkspacePrepared): Record<string, string> {
  const { HOME: _home, ...env } = gateEnvOf(p);
  return env;
}

export type WarmChoice = {
  target: WarmTarget; key: string; image: string; prepared: WorkspacePrepared; checkout: string;
  /** The image's rustc and toolchain key (WarmStatus.toolchainOf). */
  toolchain?: ToolchainId | null;
  /** Nodes whose status holds the key (WarmStatus.warmNodesFor), newest version first. */
  nodes: WarmNode[];
  /** Live workspaces per node, so the copies spread out. */
  load: Map<string, number>;
  /** The workspace container's memory limit before a memory-backed target is added. */
  memoryLimitBytes: number;
  /** Only this commit. */
  commit?: string | null;
  /** Only this node (a resume onto a kept volume). */
  node?: string | null;
};

/** Nodes whose warm volume is fuller than this are not chosen: the session's target and CARGO_HOME grow on its own volume there. */
export const WARM_NODE_MAX_FS_PCT = 85;

/**
 * The node and version a fresh workspace target starts from, or why it starts cold. Nodes holding the newest version come
 * first, then the one with the fewest workspaces, then the one with the lower disk usage; nodes above WARM_NODE_MAX_FS_PCT are skipped.
 */
export function chooseWarm(c: WarmChoice): { use: WarmUse; why: null } | { use: null; why: string } {
  if (c.target === "none") return { use: null, why: "the repository has no warm target" };
  const envHash = workspaceEnvHash(c.prepared);
  const holding = c.nodes.filter((n) => (!c.node || n.node === c.node) && (!c.commit || n.commit === c.commit));
  const nodes = holding.filter((n) => n.fsUsedPct <= WARM_NODE_MAX_FS_PCT)
    .sort((a, b) => b.stored - a.stored || (c.load.get(a.node) ?? 0) - (c.load.get(b.node) ?? 0) || a.fsUsedPct - b.fsUsedPct || a.node.localeCompare(b.node));
  let why: string | null = null;
  for (const n of nodes) {
    const d = decideWarm({
      target: c.target, key: c.key, node: n.node, status: n, image: c.image, toolchain: c.toolchain, envHash, checkout: c.checkout, cargoLock: c.prepared.cargoLock,
      memoryLimitBytes: c.memoryLimitBytes, memoryRoomBytes: null, nodeMaxBytes: null,
    });
    if (d.use) return d;
    why ??= d.why;
  }
  if (!nodes.length && holding.length) return { use: null, why: `every node holding ${c.key} has its disk over ${WARM_NODE_MAX_FS_PCT}% full` };
  const where = c.node ? `node ${c.node}` : "no node";
  return { use: null, why: why ?? `${where} holds a version of ${c.key}${c.commit ? ` at ${c.commit.slice(0, 12)}` : ""}` };
}

/** sha256 of a file's content. */
export const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

/**
 * Prepares the layout-2 volume before anything else mounts its subPaths, as the pod's user (so no dir is the runtime's
 * root-owned one) and links /work/src and /work/target to the CI paths. `$1` is the checkout path.
 */
export const LAYOUT_SH = `set -e
c=$1
mkdir -p /work/checkout/target /work/cargo-target /work/cache/cargo /work/ext/craft-fonts /work/ext/craft-i18n /work/home
link() { [ "$(readlink "$1" 2>/dev/null)" = "$2" ] || { rm -f "$1"; ln -s "$2" "$1"; }; }
link /work/src "$c"
link /work/target "$c/target"`;

/** Files of the lists WARM_MTIMES_SH reads, NUL-separated paths relative to the checkout. */
export const WARM_CHANGED_FILES = "/work/.ws/warm-changed.files";
export const WARM_CHANGED_DIRS = "/work/.ws/warm-changed.dirs";

/**
 * Sets the checkout's mtimes for a build on the warm target (as warm-copy's setMtimes does in a build pod), run in the
 * checkout. `$1` = `list`: every file to 2001-01-01 and the listed ones (and dirs) to now; `all`: every file to now.
 */
export const WARM_MTIMES_SH = `set -e
files() { find . -path ./.git -prune -o -path ./target -prune -o \\( -type f -o -type l \\) -print0; }
if [ "$1" = list ]; then
  # Trimmed version: the gate's checkouts (read-only mounts in the gate's steps) match its env, so they are old like the unchanged files.
  if [ -d /work/ext ]; then find /work/ext \\( -type f -o -type l \\) -print0 | xargs -0 -r touch -h -d @${OLD_MTIME_SEC} --; fi
  files | xargs -0 -r touch -h -d @${OLD_MTIME_SEC} --
  if [ -s ${WARM_CHANGED_FILES} ]; then xargs -0 -r touch -c -h -- <${WARM_CHANGED_FILES}; fi
  if [ -s ${WARM_CHANGED_DIRS} ]; then xargs -0 -r touch -c -- <${WARM_CHANGED_DIRS}; fi
else
  files | xargs -0 -r touch -h --
fi
rm -f ${WARM_CHANGED_FILES} ${WARM_CHANGED_DIRS}`;
