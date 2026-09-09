// SPDX-License-Identifier: AGPL-3.0-only
// electron-builder calls this once per packaged tree, which is the only place
// that knows which platform and arch that tree runs. One build makes several
// of them from one staged directory, so node-pty's native module cannot be
// staged with the rest: build:mac and build:linux on one machine would give
// every tree the building machine's build. Every other asset is the same on
// every target and is staged once by scripts/stage.mjs; this one is not.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Arch } from "electron-builder";
import { MAC_TARGETS, ptyBuild, ptyPackage, stagePty } from "./pty.mjs";

/** The tree a universal build packs one arch into before merging: electron-builder names it
 * `${appOutDir}-${arch}-temp`, and the archs are the ones the mac bundle is merged from. */
const TEMP_TREE = new RegExp(`-(?:${MAC_TARGETS.map(target => target.split("-")[1]).join("|")})-temp$`);

export default function afterPack(context) {
  const platform = context.electronPlatformName;
  const arch = Arch[context.arch];
  const targets = platform === "darwin" ? MAC_TARGETS : [`${platform}-${arch}`];
  const resources = context.packager.getResourcesDir(context.appOutDir);
  stagePty(ptyPackage(), resources, targets);
  console.log(`staged node-pty for ${targets.join(" and ")} in ${context.appOutDir}`);
  // A universal build packs each arch into its own temp tree, merges the two and calls this again on the merged
  // bundle. Only the merged one ships, and a signature on an arch tree leaves a _CodeSignature the merge refuses,
  // so the temp trees are left unsigned; electron-builder skips them for the same reason.
  if (platform !== "darwin" || TEMP_TREE.test(context.appOutDir)) return;
  // Electron's own signature no longer covers the staged resources, and Gatekeeper opens a quarantined download of
  // that as damaged; electron-builder signs after this hook when the keychain holds an identity, replacing all this.
  const entitlements = join(context.packager.projectDir, context.packager.platformSpecificBuildOptions.entitlements);
  const sign = (file, ...more) => execFileSync("codesign", ["--force", ...more, "--options", "runtime", "--entitlements", entitlements, "--sign", "-", file], { stdio: "inherit" });
  // A deep sign reaches nested bundles and frameworks, not the Mach-O files under Resources.
  for (const target of targets) {
    const build = ptyBuild(resources, target);
    for (const file of readdirSync(build)) sign(join(build, file));
  }
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  sign(app, "--deep");
  console.log(`re-signed ${app} ad hoc`);
}
