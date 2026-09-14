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

/** The targets a guest can be: every Linux row. A bundle carries all of them where the host has not read the
 * machine's own word for its chip, which is every fork of an image, since nothing answers there until the daemon
 * does, and the deploy drops the ones the machine is not; the ssh roads read the chip off the machine first and
 * carry the one row it names. */
export const GUEST_DAEMON_TARGETS: readonly DaemonTarget[] = DAEMON_TARGETS.filter(t => t.platform === "linux");

/** The binary's name, on every machine and in every folder that carries one. */
export const DAEMON_BIN = "wsp-daemon";

/** The row for a machine that says it is this platform and this chip, in node's own words for both, or nothing
 * where wsp builds no daemon for it. What a place's report is read through, since a place is another computer. */
export function daemonTargetFor(platform: string, arch: string): DaemonTarget | undefined {
  return DAEMON_TARGETS.find(t => t.platform === platform && t.arch === arch);
}

/** The row for the machine this process runs on, or nothing on a platform wsp builds no daemon for. */
export function daemonTargetHere(): DaemonTarget | undefined {
  return daemonTargetFor(process.platform, process.arch);
}

/** Where a target's binary sits inside the daemon asset. */
export function daemonBinaryIn(dir: string, triple: string): string {
  return join(dir, triple, DAEMON_BIN);
}

/** The name the release workflow uploads a target's binary under, as an artifact and as a release asset. */
export const daemonArtifactName = (triple: string): string => `${DAEMON_BIN}-${triple}`;

export const noDaemonBuildLine = (platform: string, arch: string): string =>
  `wsp builds no daemon for ${platform} ${arch}, so this computer cannot serve its own workspace or join a wsp as a place`;

/** The row a machine's own `uname -m` names, out of the targets a guest can be. The one mapping from what a box
 * says about its chip to the binary it is sent, so nothing picks that binary off the chip of the computer doing
 * the sending. Nothing for a chip wsp builds no daemon for. */
export function guestDaemonTarget(uname: string): DaemonTarget | undefined {
  const said = uname.trim();
  return GUEST_DAEMON_TARGETS.find(t => t.uname === said);
}

/** The refusal for a box whose chip wsp builds no daemon for, said before a byte of wsp's lands on it. */
export const noGuestDaemonLine = (uname: string): string =>
  `that computer says its chip is ${uname}, and wsp builds no daemon for it; wsp joins a computer running ${GUEST_DAEMON_TARGETS.map(t => t.uname).join(" or ")}`;
