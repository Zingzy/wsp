// SPDX-License-Identifier: AGPL-3.0-only
// node scripts/tag-version.mjs v1.2.3: prints the version a release tag names,
// once every manifest that carries a version agrees with it. A tag that says one
// number while the manifests say another fails here, with both numbers in the line,
// before anything is built.
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { versionedManifests } from "./release.mjs";

const TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** Whether a ref name is a release tag, the one rule for what the workflow answers to. */
export function isReleaseTag(tag) {
  return TAG.test(tag);
}

/** The version a release tag names: v1.2.3 carries 1.2.3. */
export function versionFromTag(tag) {
  const found = TAG.exec(tag);
  if (found === null) throw new Error(`not a release tag: ${tag} (expected v1.2.3)`);
  return found[1];
}

/** Every versioned manifest whose number is not the tag's, each with the number it does carry. */
export function manifestMismatches(repo, version) {
  return versionedManifests(repo)
    .map(file => ({ file: relative(repo, file), version: JSON.parse(readFileSync(file, "utf8")).version }))
    .filter(manifest => manifest.version !== version);
}

/** The version to build, or an error naming the tag's number and each manifest's. */
export function checkTag(repo, tag) {
  const version = versionFromTag(tag);
  const wrong = manifestMismatches(repo, version);
  if (wrong.length > 0) {
    const said = wrong.map(manifest => `${manifest.file} says ${manifest.version}`).join(", ");
    throw new Error(`tag ${tag} says ${version}, ${said}: retag the commit that carries ${version}`);
  }
  return version;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(checkTag(fileURLToPath(new URL("../../..", import.meta.url)), process.argv[2] ?? ""));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
