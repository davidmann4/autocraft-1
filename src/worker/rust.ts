import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TaskStep } from "./types.ts";
import { WORKSPACE_BUILD_TARGETS, WORKSPACE_TEST_TARGETS } from "./rust-targets.ts";
import type { TaskStep as PlanStep } from "../../web/src/api/types.ts";

export type RustPlanOptions = {
  /** Cargo arguments shared by build and test, e.g. ["--workspace"] or ["-p", "app"]. */
  cargoArgs?: string[];
  test?: boolean;
  fetchTimeoutSec?: number;
  buildTimeoutSec?: number;
  testTimeoutSec?: number;
  /** Globs under /out to return from the test step. */
  testArtifacts?: string[];
};

/**
 * The networked fetch runs with the image's own default toolchain, no repository cargo config and an
 * empty environment except the toolchain paths, so neither a toolchain file, a config wrapper, a
 * credential helper nor a git or cargo variable can start a program with network access (git is never
 * run: cargo fetches with its built-in client). The source overlay is discarded after the step, so
 * deleting the config files is local to it. The toolchain is the image's active one, read outside the
 * checkout (an image may pin it, as the nightly image does with RUSTUP_TOOLCHAIN).
 * `commands` are fixed command lines (never repository input), each run in that environment in turn. The CA variables
 * and CARGO_NET_RETRY that a `mirror` build pod sets pass through; the repository cannot set them.
 */
export function fetchScript(commands: string[]): string {
  const env = 'env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/tmp CARGO_HOME=/cache/cargo RUSTUP_HOME="${RUSTUP_HOME:-/usr/local/rustup}" RUSTUP_TOOLCHAIN="$tc" ' +
    "RUSTC=/usr/local/cargo/bin/rustc CARGO_REGISTRY_GLOBAL_CREDENTIAL_PROVIDERS=cargo:token CARGO_NET_GIT_FETCH_WITH_CLI=false " +
    '${CARGO_HTTP_CAINFO:+"CARGO_HTTP_CAINFO=$CARGO_HTTP_CAINFO"} ${GIT_SSL_CAINFO:+"GIT_SSL_CAINFO=$GIT_SSL_CAINFO"} ${SSL_CERT_FILE:+"SSL_CERT_FILE=$SSL_CERT_FILE"} ${CARGO_NET_RETRY:+"CARGO_NET_RETRY=$CARGO_NET_RETRY"}';
  return [
    "cd /tmp",
    "tc=$(/usr/local/cargo/bin/rustup show active-toolchain 2>/dev/null | cut -d' ' -f1)",
    'if [ -z "$tc" ]; then echo "no active rust toolchain in the image; refusing to run cargo with a toolchain chosen by the repository" >&2; exit 1; fi',
    "cd /src",
    "rm -f .cargo/config .cargo/config.toml",
    ...commands.map((c, i) => (i === commands.length - 1 ? `exec ${env} ${c}` : `${env} ${c} || exit 1`)),
  ].join("\n");
}

export const FETCH_SCRIPT = fetchScript(["/usr/local/cargo/bin/cargo fetch --locked"]);

/** Whether the checkout can use a locked plan (`--locked` needs Cargo.lock). */
export function hasCargoLock(checkoutDir: string): boolean {
  return existsSync(join(checkoutDir, "Cargo.lock"));
}

/**
 * Steps for a Rust repo: `fetch deps` is the only step with network; build and
 * test run offline on the crates it downloaded. The source is mounted
 * read-only, so the lock file must already be right (`--locked`).
 * `cargo fetch` runs no build scripts or proc macros. The crate cache and its
 * poisoning rules are described in cache.ts.
 */
export function rustPlan(o: RustPlanOptions = {}): TaskStep[] {
  const extra = o.cargoArgs ?? [];
  const workspace = extra.length === 1 && extra[0] === "--workspace";
  const steps: TaskStep[] = [
    { name: "fetch deps", cmd: ["sh", "-c", FETCH_SCRIPT], network: "fetch", timeoutSec: o.fetchTimeoutSec ?? 900 },
    { name: "build", cmd: ["cargo", "build", "--offline", "--locked", ...(workspace ? WORKSPACE_BUILD_TARGETS : ["--all-targets", ...extra])], network: "none", timeoutSec: o.buildTimeoutSec ?? 3600 },
  ];
  if (o.test ?? true) {
    steps.push({ name: "test", cmd: ["cargo", "test", "--offline", "--locked", ...(workspace ? WORKSPACE_TEST_TARGETS : extra)], network: "none", timeoutSec: o.testTimeoutSec ?? 3600, artifacts: o.testArtifacts });
  }
  return steps;
}

/**
 * The warm producer's build of a default-branch head: the CI gate's `warm-command` when it has one (AUTOCRAFT_WARM_COMMAND,
 * set by the build pod from the gate at that head; run with bash, as the gate does), else AutoCraft's whole-workspace build
 * (WORKSPACE_BUILD_TARGETS, WORKSPACE_TEST_TARGETS).
 * Offline: the pod sets CARGO_NET_OFFLINE, since a warm-command does not say --offline.
 */
export const WARM_BUILD_SCRIPT = [
  'if [ -n "${AUTOCRAFT_WARM_COMMAND:-}" ]; then echo "warm build: the CI gate\'s warm-command"; exec bash --noprofile --norc -eo pipefail -c "$AUTOCRAFT_WARM_COMMAND"; fi',
  "echo \"warm build: AutoCraft's workspace build (the gate has no warm-command)\"",
  `cargo test --locked --no-run ${WORKSPACE_TEST_TARGETS.join(" ")} || exit $?`,
  `exec cargo build --locked ${WORKSPACE_BUILD_TARGETS.join(" ")}`,
].join("\n");

/** The plan of a warm producer task: fetch the dependencies (through the crate mirror when the environment has one), then build. */
export function warmPlan(o: { mirror: boolean }): PlanStep[] {
  return [
    { name: "fetch deps", cmd: ["sh", "-c", FETCH_SCRIPT], network: o.mirror ? "mirror" : "fetch", timeoutSec: 900 },
    { name: "warm build", cmd: ["sh", "-c", WARM_BUILD_SCRIPT], network: "none", timeoutSec: 7200 },
  ];
}
