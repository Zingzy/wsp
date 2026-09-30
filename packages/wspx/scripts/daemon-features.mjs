// SPDX-License-Identifier: AGPL-3.0-only
// The cargo flags a wsp-daemon this repository ships is built with, per target: the one place every road that builds
// one reads them, a workflow's build step, a person's checkout and the staging script's check alike. It imports
// nothing outside node, so a job that has installed no packages can run it before its build.
//
//   node daemon-features.mjs [triple]   the flags for that triple, this machine's without one
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** The triple the toolchain on this machine builds for. Linux is spelled musl: the one Linux daemon wsp ships is
 * the static one, so a plain `cargo build` on a Linux box builds the wrong flavour and --triple names the right one. */
export function tripleHere() {
  const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).split("\n").find(line => line.startsWith("host: "));
  if (host === undefined) throw new Error("rustc -vV named no host");
  return host.slice("host: ".length).trim().replace(/-linux-gnu$/, "-linux-musl");
}

/** A Mac's daemon carries the tool server: a Mac is never a guest, so the feature costs no guest a byte, and an
 * agent's wsp tools run from it with no node process. A Linux daemon is a guest's, built without it. */
export function daemonFeatures(triple) {
  return triple.endsWith("-apple-darwin") ? ["--features", "mcp"] : [];
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(daemonFeatures(process.argv[2] ?? tripleHere()).join(" "));
}
