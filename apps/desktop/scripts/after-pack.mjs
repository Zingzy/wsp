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
import { ptyBuild, ptyPackage, stagePty } from "./pty.mjs";

export default function afterPack(context) {
  const target = `${context.electronPlatformName}-${Arch[context.arch]}`;
  const resources = context.packager.getResourcesDir(context.appOutDir);
  stagePty(ptyPackage(), resources, target);
  console.log(`staged node-pty for ${target} in ${context.appOutDir}`);
  if (context.electronPlatformName === "darwin") {
    // Electron's own signature no longer covers the staged resources, and Gatekeeper opens a quarantined download of
    // that as damaged; electron-builder signs after this hook when the keychain holds an identity, replacing all this.
    const entitlements = join(context.packager.projectDir, context.packager.platformSpecificBuildOptions.entitlements);
    const sign = (file, ...more) => execFileSync("codesign", ["--force", ...more, "--options", "runtime", "--entitlements", entitlements, "--sign", "-", file], { stdio: "inherit" });
    // A deep sign reaches nested bundles and frameworks, not the Mach-O files under Resources.
    for (const file of readdirSync(ptyBuild(resources, target))) sign(join(ptyBuild(resources, target), file));
    const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    sign(app, "--deep");
    console.log(`re-signed ${app} ad hoc`);
  }
}
