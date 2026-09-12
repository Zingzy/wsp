// SPDX-License-Identifier: AGPL-3.0-only
// Which wsp-daemon binary a machine runs: one row per target wsp builds, in
// the words node, uname and the Rust toolchain each use for it, so the release
// job, the bundle a guest gets, the unit a joined computer installs and the
// daemon this computer spawns all read one table. Adding a target is a row
// here and a matrix entry in the release workflow, whose test holds the two
// equal.
import { join } from "node:path";

export interface DaemonTarget {
  /** The Rust target triple: the folder the binary sits in under the daemon asset and the release artifact that carries it. */
  triple: string;
  /** node's own words for the machine that runs it. */
  platform: "linux" | "darwin";
  arch: "x64" | "arm64";
  /** What `uname -m` prints there, the one word a deploy script can read a guest's chip off. */
  uname: string;
}

export const DAEMON_TARGETS: readonly DaemonTarget[] = [
  { triple: "x86_64-unknown-linux-musl", platform: "linux", arch: "x64", uname: "x86_64" },
  { triple: "aarch64-unknown-linux-musl", platform: "linux", arch: "arm64", uname: "aarch64" },
  { triple: "aarch64-apple-darwin", platform: "darwin", arch: "arm64", uname: "arm64" },
  { triple: "x86_64-apple-darwin", platform: "darwin", arch: "x64", uname: "x86_64" },
];

/** The targets a machine wsp forks or reaches over ssh can be: every Linux row, since the host cannot read a
 * guest's chip before the bundle lands and one round trip costs more than the second file. */
export const GUEST_DAEMON_TARGETS: readonly DaemonTarget[] = DAEMON_TARGETS.filter(t => t.platform === "linux");

/** The binary's name, on every machine and in every folder that carries one. */
export const DAEMON_BIN = "wsp-daemon";

/** The row for the machine this process runs on, or nothing on a platform wsp builds no daemon for. */
export function daemonTargetHere(platform: string = process.platform, arch: string = process.arch): DaemonTarget | undefined {
  return DAEMON_TARGETS.find(t => t.platform === platform && t.arch === arch);
}

/** Where a target's binary sits inside the daemon asset. */
export function daemonBinaryIn(dir: string, triple: string): string {
  return join(dir, triple, DAEMON_BIN);
}

/** The name the release workflow uploads a target's binary under, as an artifact and as a release asset. */
export const daemonArtifactName = (triple: string): string => `${DAEMON_BIN}-${triple}`;

/** The name a Linux binary travels under in a guest's bundle, by the chip word the deploy reads off uname. */
export const bundledDaemonName = (target: DaemonTarget): string => `${DAEMON_BIN}-${target.uname}`;

export const noDaemonBuildLine = (platform: string, arch: string): string =>
  `wsp builds no daemon for ${platform} ${arch}, so this computer cannot serve its own workspace or join a wsp as a place`;
