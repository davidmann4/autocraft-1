/**
 * AutoCraft's whole-workspace build: build pods' `--workspace` plans run it, the warm producer builds it by default and
 * workspace sessions are told to run it, so all of them use the warm version's units. Examples, benches and doctests are left out (cargo test builds examples by default):
 * the repository's own CI covers them.
 */
export const WORKSPACE_BUILD_TARGETS = ["--workspace", "--lib", "--bins"];
export const WORKSPACE_TEST_TARGETS = ["--workspace", "--lib", "--bins", "--tests"];
/** The whole-workspace build as a session runs it from /work/src. */
export const WORKSPACE_BUILD_COMMANDS = [
  `cargo build --offline --locked ${WORKSPACE_BUILD_TARGETS.join(" ")}`,
  `cargo test --offline --locked ${WORKSPACE_TEST_TARGETS.join(" ")}`,
];
