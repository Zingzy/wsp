// SPDX-License-Identifier: AGPL-3.0-only
// electron-builder calls this once per packaged tree, which is the only place
// that knows which platform and arch that tree runs. One build makes several
// of them from one staged directory, so node-pty's native module cannot be
// staged with the rest: build:mac and build:linux on one machine would give
// every tree the building machine's build. The daemon travels as an extra
// resource because it is the same on every target; this one is not.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Arch } from "electron-builder";
import { ptyPackage, stagePty } from "./pty.mjs";

export default function afterPack(context) {
  const target = `${context.electronPlatformName}-${Arch[context.arch]}`;
  stagePty(ptyPackage(), context.packager.getResourcesDir(context.appOutDir), target);
  console.log(`staged node-pty for ${target} in ${context.appOutDir}`);
  if (context.electronPlatformName === "darwin") {
    // The bundle is not signed by a developer yet (identity null), so it still carries Electron's own ad-hoc
    // signature, which no longer covers the resources staged above; Gatekeeper reads a quarantined download of that
    // as damaged and offers no way in. A fresh ad-hoc signature over the whole bundle makes it an unsigned app again,
    // the kind a right-click Open admits.
    const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
    console.log(`re-signed ${app} ad hoc`);
  }
}
