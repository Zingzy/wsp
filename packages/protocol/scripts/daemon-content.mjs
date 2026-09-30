// SPDX-License-Identifier: AGPL-3.0-only
// The sha that names what a deploy installs on a guest: the one rule the host's
// daemon-content test holds the record to and the landing's cut appends, so the
// two cannot hash one tree two ways. Sources, not the built binary: a build
// differs by toolchain and machine, and the sources are what a version stands
// for. Plain node, since the cut runs on a tree nothing has built yet.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Where the pieces of a deploy the host renders are recorded, relative to the daemon tree: the three scripts the
 * deploy writes beside the binary, the roots path and the work-score line the daemon reads through the contract.
 * The host's own content test holds this file to what the host renders today. */
export const DEPLOYED_PATH = join("fixtures", "deployed.json");

/** Every file under a folder, relative and sorted, so the walk reads the same whatever the folder's own path is. */
function relPaths(dir, keep, prefix = "") {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? relPaths(join(dir, e.name), keep, `${prefix}${e.name}/`) : keep(e.name) ? [`${prefix}${e.name}`] : []))
    .sort();
}

const isSource = name => name.endsWith(".rs") || name === "Cargo.toml";
const isFixture = name => name.endsWith(".json");
/** A crate's tests/ folder is built for a test run and never linked into the binary, so nothing under it reaches a
 * guest and a change there must not cut a version. An inline #[cfg(test)] module stays hashed: the file holding it
 * ships, and reading past it would cost a Rust parser here. */
const underTests = rel => /(^|\/)tests\//.test(rel);
/** The tool server for an agent on the host's own computer: a feature the guest build leaves off, so no deploy
 * carries a line of it and a change to it must not cut a version. */
const hostOnly = rel => rel.startsWith("wsp-mcp/");

/** A file's text as the sha reads it. Two files carry the version itself, in Rust and in the fixture the Rust is
 * held to, and a sha over the version would move the moment it was recorded: the line and the key that hold it
 * are taken out, and every cap and default beside them stays in, so a changed cap moves the version and the
 * version never chases its own hash. */
function hashed(rel, text) {
  if (rel.endsWith("/numbers.rs")) return text.split("\n").filter(line => !line.includes("DAEMON_VERSION")).join("\n");
  if (rel.endsWith("/numbers.json")) {
    const { daemonVersion: _version, ...numbers } = JSON.parse(text);
    return JSON.stringify(numbers);
  }
  return text;
}

/** The pieces of a deploy the host renders, as recorded beside the daemon tree. */
export function readDeployed(daemonTree) {
  return JSON.parse(readFileSync(join(daemonTree, DEPLOYED_PATH), "utf8"));
}

/** What a deploy leaves on a guest and this can hash: the Rust sources the binary is built from, each crate's
 * manifest and none of its tests/ folder nor of the crate only the host's own build links, the lock that pins every
 * dependency, the C library the Linux builds link and the release it is pinned to, the contract fixtures the
 * binary's words, numbers and frames are held to, DAEMON_ROOTS_PATH and the work-score line the daemon reads through
 * that contract, and the scripts the host writes beside the binary, whose content outlives the deploy that wrote it. */
export function daemonContentSha(daemonTree, deployed = readDeployed(daemonTree)) {
  const h = createHash("sha256");
  const crates = join(daemonTree, "crates");
  for (const rel of relPaths(crates, isSource).filter(rel => !underTests(rel) && !hostOnly(rel))) h.update(`crates/${rel}\n${hashed(`crates/${rel}`, readFileSync(join(crates, rel), "utf8"))}\n`);
  for (const file of ["Cargo.toml", "Cargo.lock", "scripts/libseccomp-archive.sh"]) h.update(`${file}\n${readFileSync(join(daemonTree, file), "utf8")}\n`);
  const contract = join(daemonTree, "fixtures", "contract");
  for (const rel of relPaths(contract, isFixture)) h.update(`fixtures/contract/${rel}\n${hashed(`fixtures/contract/${rel}`, readFileSync(join(contract, rel), "utf8"))}\n`);
  h.update(`${deployed.rootsPath}\n`);
  h.update(`${deployed.workScoreLine}\n`);
  for (const s of deployed.scripts) h.update(`${s}\n`);
  return h.digest("hex");
}
