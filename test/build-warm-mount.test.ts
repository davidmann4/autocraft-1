// A build pod starts warm only from a version its own node holds, built with the pod's image and CI env, and for a
// volume-backed target only from the checkout's own Cargo.lock; the warm pod copies from that node's claim first.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ciCheckout, groupsOf, parseSettings, stepPod, warmEnvHash, type Prepared } from "../src/build/pods.ts";
import { decideWarm, WARM_COPY_CONTAINER, type WarmInputs } from "../src/build/warm-mount.ts";
import type { TaskStep } from "../web/src/api/types.ts";

test("warm starts need the key on the task's node and, on the volume, the same Cargo.lock; otherwise cold", () => {
  const prepared: Prepared = { env: { CARGO_TERM_COLOR: "always" }, mounts: [], packages: [], craftFontsRef: null, craftI18nRev: null, cacheVersion: "v1", cargoLock: "a".repeat(64) };
  const envHash = warmEnvHash(prepared);
  const status = { commit: "c".repeat(40), stored: 1, bytes: 5e9, image: "rust:1", envHash, synced: 1, cargoLock: "a".repeat(64) };
  const base: WarmInputs = { target: "pvc", key: "deckcraft-0123", node: "k3s-2", status, image: "rust:1", envHash, checkout: ciCheckout("deckcraft"), cargoLock: prepared.cargoLock!, memoryLimitBytes: 16 * 1024 ** 3, memoryRoomBytes: 16 * 1024 ** 3, nodeMaxBytes: 64 * 1024 ** 3 };

  assert.ok(decideWarm(base).use);
  assert.equal(decideWarm({ ...base, status: null }).use, null, "the node holds no version");
  assert.equal(decideWarm({ ...base, node: null }).use, null, "the node is not known");
  assert.equal(decideWarm({ ...base, cargoLock: "b".repeat(64) }).use, null, "pvc: another Cargo.lock");
  assert.equal(decideWarm({ ...base, status: { ...status, cargoLock: null } }).use, null, "pvc: the version records no Cargo.lock");
  assert.ok(decideWarm({ ...base, target: "tmpfs", cargoLock: "b".repeat(64) }).use, "tmpfs does not need the same Cargo.lock");
  assert.equal(decideWarm({ ...base, target: "tmpfs", status: { ...status, bytes: 30e9 } }).use, null, "tmpfs: larger than memory allows");
  assert.equal(decideWarm({ ...base, target: "tmpfs", memoryRoomBytes: 1024 ** 3 }).use, null, "tmpfs: more than the run reserved");
  assert.equal(decideWarm({ ...base, status: { ...status, image: "rust:2" } }).use, null, "another toolchain image");
  assert.equal(decideWarm({ ...base, target: "none" }).use, null);

  const s = parseSettings({ toolchainImages: { "rust-stable": "rust:1" } });
  const plan: TaskStep[] = [{ name: "test", cmd: ["cargo", "test"], network: "none", timeoutSec: 600 } as TaskStep];
  const ctx = { s, envId: "k", taskId: 1, stage: 2, name: "p", pvc: "v", deadlineSec: 900, node: "k3s-2" };
  const spec = (use?: ReturnType<typeof decideWarm>["use"]) => stepPod(ctx, "rust:1", "app:1", plan, groupsOf(plan)[0]!, prepared, false, "deckcraft", undefined, use ?? undefined) as {
    spec: { initContainers?: { name: string }[]; volumes: { persistentVolumeClaim?: { claimName: string; readOnly?: boolean } }[] };
  };
  const warm = spec(decideWarm(base).use).spec;
  assert.ok(warm.initContainers?.some((c) => c.name === WARM_COPY_CONTAINER));
  assert.ok(warm.volumes.some((v) => v.persistentVolumeClaim?.claimName === "craft-warm-k3s-2" && v.persistentVolumeClaim.readOnly));
  const cold = spec(decideWarm({ ...base, status: null }).use).spec;
  assert.ok(!cold.initContainers?.some((c) => c.name === WARM_COPY_CONTAINER));
  assert.ok(!cold.volumes.some((v) => v.persistentVolumeClaim?.claimName.startsWith("craft-warm-")));
});

test("a rebuilt toolchain image starts from versions of the old one when rustc and the toolchain key match", () => {
  const prepared: Prepared = { env: {}, mounts: [], packages: [], craftFontsRef: null, craftI18nRev: null, cacheVersion: "v1", cargoLock: "a".repeat(64) };
  const envHash = warmEnvHash(prepared);
  const rustc = "rustc 1.100.0 (abc 2026-11-01)\nhost: x86_64-unknown-linux-gnu\n";
  const toolchain = { rustc, toolchain: "d".repeat(64) };
  const status = { commit: "c".repeat(40), stored: 1, bytes: 5e9, image: "rust@sha256:old", ...toolchain, envHash, synced: 1, cargoLock: "a".repeat(64) };
  const base: WarmInputs = { target: "pvc", key: "deckcraft-0123", node: "k3s-2", status, image: "rust@sha256:new", toolchain, envHash, checkout: ciCheckout("deckcraft"), cargoLock: prepared.cargoLock!, memoryLimitBytes: 16 * 1024 ** 3, memoryRoomBytes: null, nodeMaxBytes: null };

  assert.ok(decideWarm(base).use, "same rustc and toolchain key, another digest");
  assert.equal(decideWarm({ ...base, toolchain: { ...toolchain, rustc: rustc.replace("1.100.0", "1.101.0") } }).use, null, "another rustc");
  assert.equal(decideWarm({ ...base, toolchain: { ...toolchain, toolchain: "e".repeat(64) } }).use, null, "another build tool or -dev package");
  assert.equal(decideWarm({ ...base, toolchain: null }).use, null, "the new image's key is not known yet");
  assert.equal(decideWarm({ ...base, status: { ...status, rustc: null, toolchain: null } }).use, null, "a version that records no key matches only its digest");
});
