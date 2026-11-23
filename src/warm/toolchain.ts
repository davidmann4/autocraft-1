// What a warm version was built with, and which toolchain images may start from it.
//
// A version records the toolchain image digest it was built with, `rustc -vV`, and the image's toolchain key: the sha256 of
// TOOLCHAIN_FILE, which deploy/container/Containerfile.rust-stable writes at build time (Rust release, components, targets,
// sccache release, versions of the C toolchain, of the tools build scripts run or load and of every `-dev` package: what can
// change compiled output). A pod starts from a version built with its own image, or with
// one whose rustc and toolchain key both match: a rebuilt image with the same content keeps the warm versions.
//
// Only a toolchain-image container can read the image's rustc and file, so warm pods run TOOLCHAIN_ID_SH there first; it
// writes both into a dir the AutoCraft-image phases read (readToolchain).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Written by Containerfile.rust-stable. An image without it is matched by digest only. */
export const TOOLCHAIN_FILE = "/usr/local/share/autocraft/toolchain.txt";
export const TOOLCHAIN_ID_CONTAINER = "toolchain-id";

/** `rustc -vV` output and the toolchain key (sha256 of TOOLCHAIN_FILE); null when not known. */
export type ToolchainId = { rustc: string | null; toolchain: string | null };
/** What a version was built with, or what a pod builds with. */
export type BuiltWith = ToolchainId & { image: string | null };

const complete = (t: ToolchainId): boolean => !!t.rustc && !!t.toolchain;

/** Whether a pod that builds with `now` may start from a version built with `built`. */
export function sameToolchain(built: BuiltWith, now: BuiltWith): boolean {
  if (built.image && built.image === now.image) return true;
  return complete(built) && complete(now) && built.rustc === now.rustc && built.toolchain === now.toolchain;
}

/** Why a version built with `built` is refused (null: it is not), for "<version> <reason>" log lines. */
export function toolchainRefusal(built: BuiltWith, now: BuiltWith): string | null {
  if (sameToolchain(built, now)) return null;
  if (complete(built) && complete(now)) return built.rustc !== now.rustc ? "was built with another rustc" : "was built with another toolchain key (packages or Rust components)";
  const other = complete(built) ? `the toolchain key of ${now.image ?? "this image"} is not known` : "it records no toolchain key";
  return `was built with ${built.image ?? "an unrecorded image"}, not ${now.image ?? "an unrecorded image"}, and ${other}`;
}

/**
 * Run in the toolchain image with the output dir as `$1`: `rustc -vV` into rustc.txt and a copy of TOOLCHAIN_FILE into
 * toolchain.txt. A missing rustc or file leaves that file out, which only narrows the match to the digest.
 */
export const TOOLCHAIN_ID_SH = `mkdir -p "$1"
rustc -vV > "$1/rustc.txt" 2>/dev/null || rm -f "$1/rustc.txt"
cp ${TOOLCHAIN_FILE} "$1/toolchain.txt" 2>/dev/null || rm -f "$1/toolchain.txt"
exit 0`;

/** What TOOLCHAIN_ID_SH wrote into `dir`. */
export function readToolchain(dir: string | undefined): ToolchainId {
  const read = (n: string): Buffer | null => {
    const f = dir ? join(dir, n) : null;
    try {
      return f && existsSync(f) ? readFileSync(f) : null;
    } catch {
      return null;
    }
  };
  const rustc = read("rustc.txt")?.toString("utf8").trim().slice(0, 4096) || null;
  const file = read("toolchain.txt");
  return { rustc, toolchain: file && file.length ? createHash("sha256").update(file).digest("hex") : null };
}
