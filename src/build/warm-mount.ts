// Build pods that start warm: an offline step pod of a repository with a warm target (build_sizes.warm_target) whose node
// holds the repository's warm key (warm-sync, src/warm/sync-agent.ts) copies that version into its target dir before its
// steps run, instead of building from an empty one. A `fetch` or `mirror` step pod before it (the dependency fetch) copies
// only the version's CARGO_HOME before its steps, so the fetch downloads only what the version lacks.
//
// The node's warm dir reaches the pod through the read-only claim `craft-warm-<node>` (a static volume over the node's
// /var/lib/craft-warm; a hostPath volume is not allowed in the build namespace) mounted with `subPath: <key>` at /warm.
// The `warm-copy` init container (AutoCraft image, src/worker/warm-copy.ts) verifies the version's signed record with the
// `warm-verify-key` ConfigMap, checks the manifest, the paths, the toolchain (the image, or its rustc and toolchain key, which
// the `toolchain-id` init container before it reads from the toolchain image: src/warm/toolchain.ts), the CI env and (for `pvc`) the Cargo.lock, and
// then copies target and CARGO_HOME. Anything that does not match is a cold start, logged. It also sets the checkout's
// mtimes so cargo rebuilds only what changed since the warm commit.
//
// Targets: `tmpfs` puts the copy in a memory-backed dir of warmTmpfsBytes, which the pod's memory request and limit grow by
// (the run reserves it on its node when it starts, launcher.ts requestOf); `pvc` puts it on the task's volume and only when the version was built from the same Cargo.lock as the
// checkout: a target one dependency update behind saves about what the copy costs.
import type { KeyStatus } from "../warm/sync-agent.ts";
import { toolchainRefusal, TOOLCHAIN_ID_SH, type ToolchainId } from "../warm/toolchain.ts";

export const WARM_TARGETS = ["tmpfs", "pvc", "none"] as const;
export type WarmTarget = (typeof WARM_TARGETS)[number];

/** A warm target in memory takes this share more than the version's size: the build adds to what the copy put there. */
export const WARM_MEMORY_FACTOR = 1.2;
/** Above this much expected target a memory-backed target is refused: the repository's target belongs on the volume. */
export const WARM_MEMORY_MAX_BYTES = 32 * 1024 ** 3;

export const WARM_COPY_CONTAINER = "warm-copy";
export const WARM_VERIFY_CONFIGMAP = "warm-verify-key";
export const WARM_MOUNT = "/warm";
export const WARM_VERIFY_DIR = "/keys/verify";
/** Written by the source pod into the task's volume: the checkout's files that differ from the warm commit (src/worker/warm-copy.ts). */
export const CHANGED_FILE = "warm-changed.json";
/** Written by warm-copy into the task's volume: whether a volume-backed target holds a finished copy. */
export const COPY_MARK_FILE = "warm-copy.json";

const NODE_RE = /^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$/;
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** How an offline step pod starts warm. */
export type WarmUse = {
  target: "tmpfs" | "pvc"; node: string; key: string; commit: string; bytes: number;
  /** The version must have been built from the checkout's Cargo.lock (warm-copy checks it again). */
  sameLock: boolean;
};

export type WarmInputs = {
  target: WarmTarget; key: string;
  /** The node the task's volume is on; null when it is not known yet. */
  node: string | null;
  /** That node's fresh warm status for the key; null when it holds none. */
  status: KeyStatus | null;
  /** The step pod's toolchain image, CI env hash (pods.ts warmEnvHash) and CI checkout path. */
  image: string; envHash: string; checkout: string | null;
  /** The image's rustc and toolchain key as a version built with it records them (WarmStatus.toolchainOf); null when no version records it. */
  toolchain?: ToolchainId | null;
  /** sha256 of the checkout's Cargo.lock as the source pod found it; null when it has none. */
  cargoLock: string | null;
  /** The step containers' memory limit before a memory-backed target is added to it. */
  memoryLimitBytes: number;
  /** What the run reserved on its node beyond the step containers' request; null when no reservation was made (no capacity view). */
  memoryRoomBytes: number | null;
  /** The most allocatable memory of any build node; null when not known. */
  nodeMaxBytes: number | null;
};

/** Whether the task's offline pod starts warm, or why it starts cold. */
export function decideWarm(i: WarmInputs): { use: WarmUse; why: null } | { use: null; why: string } {
  const cold = (why: string) => ({ use: null, why });
  if (i.target === "none") return cold("the repository has no warm target");
  if (!i.checkout) return cold("the repository has no CI checkout path");
  if (!i.node || !NODE_RE.test(i.node)) return cold("the task's node is not known");
  if (!KEY_RE.test(i.key)) return cold(`${i.key} is not a warm key`);
  const s = i.status;
  if (!s) return cold(`node ${i.node} holds no version of ${i.key}`);
  const at = `${i.key}@${s.commit.slice(0, 12)} on ${i.node}`;
  const refused = toolchainRefusal({ image: s.image, rustc: s.rustc ?? null, toolchain: s.toolchain ?? null }, { image: i.image, rustc: i.toolchain?.rustc ?? null, toolchain: i.toolchain?.toolchain ?? null });
  if (refused) return cold(`${at} ${refused}`);
  if (s.envHash !== i.envHash) return cold(`${at} was built with another CI env`);
  if (i.target === "tmpfs") {
    const need = warmTmpfsBytes(s.bytes);
    if (need > WARM_MEMORY_MAX_BYTES || (i.memoryRoomBytes !== null && need > i.memoryRoomBytes) || (i.nodeMaxBytes !== null && i.memoryLimitBytes + need > i.nodeMaxBytes)) {
      return cold(`${at} (${gb(s.bytes)} GB) does not fit in memory`);
    }
  } else if (!s.cargoLock || !i.cargoLock || s.cargoLock !== i.cargoLock) {
    return cold(`${at} was built from ${s.cargoLock ? "another Cargo.lock" : "an unrecorded Cargo.lock"}${i.cargoLock ? "" : " (the checkout has none)"}`);
  }
  return { use: { target: i.target, node: i.node, key: i.key, commit: s.commit, bytes: s.bytes, sameLock: i.target === "pvc" }, why: null };
}

const gb = (b: number) => (b / 1e9).toFixed(1);

/** The node's warm claim, read-only. */
export const warmNodeVolume = (use: WarmUse) => ({ name: "warm-node", persistentVolumeClaim: { claimName: `craft-warm-${use.node}`, readOnly: true } });
/** Optional: without the ConfigMap the pod still starts, and warm-copy starts cold. */
export const warmVerifyVolume = () => ({ name: "warm-copy-verify", configMap: { name: WARM_VERIFY_CONFIGMAP, items: [{ key: "public.pem", path: "public.pem" }], optional: true } });

/** Fixed room on top of a memory-backed target: a Cargo.lock change builds a second set of dependency units beside the copy. */
export const WARM_TMPFS_HEADROOM_BYTES = 4 * 1024 ** 3;
/** A memory-backed target's size limit, and what it adds to the pod's memory request and limit: the copy and what the build adds. */
export const warmTmpfsBytes = (bytes: number): number => Math.ceil(bytes * WARM_MEMORY_FACTOR) + WARM_TMPFS_HEADROOM_BYTES;

/** Where a consumer pod's toolchain-id container writes, on the volume warm-copy mounts at /tmp. */
export const TOOLCHAIN_ID_DIR = "/tmp/toolchain";

/**
 * The toolchain-id container's command, env and mounts (toolchain image, before the phase that reads `dir`; the pod adds name,
 * image, resources and security). `volumeMounts` must make `dir` and /tmp writable.
 */
export const toolchainIdParts = (volumeMounts: object[], dir = TOOLCHAIN_ID_DIR) => ({
  command: ["/bin/sh", "-c", TOOLCHAIN_ID_SH, "toolchain-id", dir],
  env: [{ name: "HOME", value: "/tmp" }],
  volumeMounts,
});

/**
 * The warm-copy container's args, env and mounts (pods.ts and workspace-pods.ts add image and resources). `target` is the
 * target volume as the steps mount it, at `checkout`/target; CARGO_HOME is /cache/cargo on the volume `work`. `env` adds
 * settings (a workspace's checkout arrives after the copy: warm-copy.ts warmCopyPhase). `cargoOnly`: the copy before a
 * network pod's fetch, which fills only CARGO_HOME and does not mount the target.
 */
export function warmCopyParts(use: WarmUse, o: { checkout: string; image: string; envHash: string; targetVolume: { name: string; subPath?: string }; tmpVolume: string; env?: Record<string, string>; cargoOnly?: boolean }) {
  const target = `${o.checkout}/target`;
  const env: Record<string, string> = {
    HOME: "/tmp", AUTOCRAFT_POD_WORK: "/work",
    AUTOCRAFT_WARM_KEY: use.key, AUTOCRAFT_WARM_COMMIT: use.commit, AUTOCRAFT_WARM_SOURCE: WARM_MOUNT, AUTOCRAFT_WARM_VERIFY_KEYS: `${WARM_VERIFY_DIR}/public.pem`,
    AUTOCRAFT_WARM_TARGET: target, AUTOCRAFT_WARM_CARGO_HOME: "/cache/cargo", AUTOCRAFT_WARM_CHECKOUT: o.checkout,
    AUTOCRAFT_WARM_IMAGE: o.image, AUTOCRAFT_WARM_TOOLCHAIN_DIR: TOOLCHAIN_ID_DIR, AUTOCRAFT_WARM_ENV_HASH: o.envHash, AUTOCRAFT_WARM_MODE: use.target,
    ...(o.cargoOnly ? { AUTOCRAFT_WARM_PART: "cargo" } : use.sameLock ? { AUTOCRAFT_WARM_SAME_LOCK: "1" } : {}),
    ...o.env,
  };
  return {
    args: ["worker", "pod", WARM_COPY_CONTAINER],
    env: Object.entries(env).map(([name, value]) => ({ name, value })),
    volumeMounts: [
      { name: "warm-node", mountPath: WARM_MOUNT, subPath: use.key, readOnly: true },
      { name: "warm-copy-verify", mountPath: WARM_VERIFY_DIR, readOnly: true },
      ...(o.cargoOnly ? [] : [{ ...o.targetVolume, mountPath: target }]),
      { name: "work", mountPath: "/work" },
      { name: "work", mountPath: "/cache", subPath: "cache" },
      { name: o.tmpVolume, mountPath: "/tmp" },
    ],
  };
}
