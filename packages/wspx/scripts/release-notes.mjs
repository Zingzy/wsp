// SPDX-License-Identifier: AGPL-3.0-only
// node scripts/release-notes.mjs v1.2.3: the notes for that tag's draft release,
// from the commits since the tag before it plus the README's lines on unsigned
// bundles. Prints markdown; writes nothing.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isReleaseTag, versionFromTag } from "./tag-version.mjs";

// The README owns this text so the page a stranger reads and the notes they get
// with the download cannot drift apart; the markers are how it is lifted out.
const UNSIGNED = /<!-- unsigned:start -->\n([\s\S]*?)<!-- unsigned:end -->/;
const RENUMBER = /^chore: v\d/;
// The name on npm has one home, the manifest of the package that is published under it.
const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).name;

/** Semver order: 0.1.10 is above 0.1.9, and a release is above its own prereleases. */
export function compareVersions(a, b) {
  const split = version => {
    const [core, pre] = version.split("-");
    return { core: core.split(".").map(Number), pre };
  };
  const [left, right] = [split(a), split(b)];
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i];
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/** The release tag below this one, which is where the change list starts. */
export function previousTag(tags, tag) {
  const version = versionFromTag(tag);
  const below = tags
    .map(t => t.trim())
    .filter(t => isReleaseTag(t))
    .map(t => versionFromTag(t))
    .filter(v => compareVersions(v, version) < 0)
    .sort(compareVersions);
  const last = below.at(-1);
  return last === undefined ? undefined : `v${last}`;
}

/** The commit subjects worth reading, once each. The renumbering commit is the release itself. */
export function changeLines(subjects) {
  const kept = [];
  for (const subject of subjects) {
    const line = subject.trim();
    if (line.length === 0 || RENUMBER.test(line) || kept.includes(line)) continue;
    kept.push(line);
  }
  return kept;
}

/** What each bundle on the release page is called, for the notes and the workflow alike. */
export function bundleNames(version) {
  return {
    macArm64: `wsp-${version}-mac-arm64.zip`,
    macX64: `wsp-${version}-mac-x64.zip`,
    appImage: `wsp-${version}.AppImage`,
  };
}

/** The README's lines on unsigned bundles, so the notes say what the page says. */
export function unsignedNote(readme) {
  const found = UNSIGNED.exec(readme);
  if (found === null) throw new Error("README.md has no unsigned:start and unsigned:end markers to read the bundle lines from");
  return found[1].trim();
}

export function releaseNotes({ version, previous, changes, unsigned }) {
  const names = bundleNames(version);
  return [
    previous === undefined ? "## What changed" : `## What changed since ${previous}`,
    "",
    ...(changes.length > 0 ? changes.map(line => `- ${line}`) : ["- The first release."]),
    "",
    "## Downloads",
    "",
    `- \`${names.macArm64}\`: macOS on Apple silicon.`,
    `- \`${names.macX64}\`: macOS on Intel.`,
    `- \`${names.appImage}\`: Linux on x64.`,
    `- The command line: \`npm i -g ${PACKAGE}@${version}\`.`,
    "",
    unsigned,
    "",
  ].join("\n");
}

function notesFor(repo, tag) {
  const git = args => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  const previous = previousTag(git(["tag", "--list", "v*"]).split("\n"), tag);
  const subjects = previous === undefined ? [] : git(["log", "--no-merges", "--pretty=format:%s", `${previous}..${tag}`]).split("\n");
  return releaseNotes({
    version: versionFromTag(tag),
    previous,
    changes: changeLines(subjects),
    unsigned: unsignedNote(readFileSync(join(repo, "README.md"), "utf8")),
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(notesFor(fileURLToPath(new URL("../../..", import.meta.url)), process.argv[2] ?? ""));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
