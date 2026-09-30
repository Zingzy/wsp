#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Cuts the next daemon version on the tree that lands, so no branch carries
// one and no two branches conflict on the record. The landing runs it after
// main is merged in and before the squash:
//
//   node packages/protocol/scripts/cut-daemon-version.mjs --note "<the pull request's title>"
//
// It refuses a tree with anything uncommitted, untracked files included, before
// it reads a file: the cut lands with the squash, and what nobody committed is
// what nobody reviewed. It hashes the daemon tree by the one rule the content
// test reads, and where that sha is already the record's last entry it cuts
// nothing: a branch with no daemon change lands as it is. Otherwise it appends
// the sha as the next version, writes that version into numbers.rs and the
// contract fixture, and adds one line to the version notes: the branch's own
// daemon/version-note.md where it wrote one, which then goes, or the note it
// was handed.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { daemonContentSha } from "./daemon-content.mjs";

/** Every file the cut reads or writes, relative to the repo. */
export const CUT_PATHS = {
  record: "packages/protocol/src/index.ts",
  rust: "daemon/crates/wsp-frames/src/numbers.rs",
  fixture: "daemon/fixtures/contract/numbers.json",
  note: "daemon/version-note.md",
};

const OPEN = "const DAEMON_CONTENTS = [\n";
const CLOSE = "\n];";
const ENTRY = /^\s*(UNRECORDED|"[0-9a-f]{64}"),/;
const VERSION_LINE = "\nexport const DAEMON_VERSION = DAEMON_CONTENTS.length;";
const RUST = /pub const DAEMON_VERSION: u32 = (\d+);/;
const FIXTURE = /"daemonVersion": (\d+)/;
/** The widest a line of the notes runs, its " * " included, as the rest of the file wraps. */
const WIDTH = 120;

/** The record's entries in order, each as written: a quoted sha, or UNRECORDED for a version with none to name. */
export function recordOf(text) {
  const at = text.indexOf(OPEN);
  if (at === -1) throw new Error(`${CUT_PATHS.record} holds no DAEMON_CONTENTS record`);
  const body = text.slice(at + OPEN.length, text.indexOf(CLOSE, at));
  return body.split("\n").flatMap(line => ENTRY.exec(line)?.slice(1, 2) ?? []);
}

/** A note as the record's notes read it: no conventional prefix a title carries, and a sentence's full stop. */
function noteLine(version, note) {
  const said = note.trim().replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "").replace(/\s+/g, " ");
  const words = `Version ${version}: ${said}${/[.!?]$/.test(said) ? "" : "."}`.split(" ");
  const lines = [];
  for (const word of words) {
    const last = lines.at(-1);
    if (last !== undefined && ` * ${last} ${word}`.length <= WIDTH) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines.map(line => ` * ${line}`).join("\n");
}

/** One match of a version pattern in a file's text, read as a number; a file with none or with two is refused. */
function versionIn(text, pattern, path) {
  const all = [...text.matchAll(new RegExp(pattern.source, "g"))];
  if (all.length !== 1) throw new Error(`${path} carries ${all.length} daemon versions, where the cut reads one`);
  return Number(all[0][1]);
}

/** What git says is not committed in the checkout, a line per path, untracked files among them; a folder git reads no
 * status of is refused, since a cut over it would stand on nothing anybody committed. */
function uncommitted(repo) {
  try {
    return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n").filter(line => line !== "");
  } catch (e) {
    const said = e instanceof Error && "stderr" in e ? String(e.stderr).trim() : String(e);
    throw new Error(`the cut runs on a git checkout, and git read no status of ${repo}: ${said}`);
  }
}

/** Cuts the next version where this tree's daemon changed since the last one, and says which version stands. */
export function cutDaemonVersion(repo, { note } = {}) {
  const dirty = uncommitted(repo);
  if (dirty.length > 0) throw new Error(`the tree holds uncommitted changes, which the cut would land unreviewed; commit or drop them first:\n${dirty.join("\n")}`);
  const at = path => join(repo, path);
  const record = readFileSync(at(CUT_PATHS.record), "utf8");
  const rust = readFileSync(at(CUT_PATHS.rust), "utf8");
  const fixture = readFileSync(at(CUT_PATHS.fixture), "utf8");
  const entries = recordOf(record);
  const n = entries.length;
  // A branch that still carries a version of its own disagrees with the record here, and a cut over it would stand
  // on a number somebody else holds.
  for (const [path, version] of [
    [CUT_PATHS.rust, versionIn(rust, RUST, CUT_PATHS.rust)],
    [CUT_PATHS.fixture, versionIn(fixture, FIXTURE, CUT_PATHS.fixture)],
  ]) {
    if (version !== n) throw new Error(`${path} says daemon ${version} while the record holds ${n}; a branch carries no version, so take it back to ${n} and let the landing cut the next`);
  }
  const sha = daemonContentSha(at("daemon"));
  if (entries.at(-1) === `"${sha}"`) return { cut: false, version: n };
  const noteFile = at(CUT_PATHS.note);
  const said = existsSync(noteFile) ? readFileSync(noteFile, "utf8") : note;
  if (said === undefined || said.trim() === "") throw new Error(`the daemon changed, and a new version lands with a note: write ${CUT_PATHS.note} on the branch, or hand the cut --note`);
  const version = n + 1;
  const close = record.indexOf(CLOSE, record.indexOf(OPEN));
  let next = `${record.slice(0, close)}\n  "${sha}",${record.slice(close)}`;
  const end = next.indexOf(VERSION_LINE);
  if (end === -1 || !next.slice(0, end).endsWith(" */")) throw new Error(`${CUT_PATHS.record}: the version notes do not end right above DAEMON_VERSION`);
  next = `${next.slice(0, end - " */".length)}\n${noteLine(version, said)} */${next.slice(end)}`;
  writeFileSync(at(CUT_PATHS.record), next);
  writeFileSync(at(CUT_PATHS.rust), rust.replace(RUST, `pub const DAEMON_VERSION: u32 = ${version};`));
  writeFileSync(at(CUT_PATHS.fixture), fixture.replace(FIXTURE, `"daemonVersion": ${version}`));
  if (existsSync(noteFile)) rmSync(noteFile);
  return { cut: true, version, sha };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = name => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  try {
    const repo = flag("--repo") ?? fileURLToPath(new URL("../../../", import.meta.url));
    const note = flag("--note");
    const done = cutDaemonVersion(repo, note === undefined ? {} : { note });
    console.log(done.cut ? `cut daemon version ${done.version}: ${done.sha}` : `the daemon did not change: version ${done.version} stands`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
