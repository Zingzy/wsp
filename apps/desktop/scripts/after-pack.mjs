// SPDX-License-Identifier: AGPL-3.0-only
// electron-builder calls this once per packaged tree, which is the only place
// that knows which platform and arch that tree runs. One build makes several
// of them from one staged directory, so node-pty's native module cannot be
// staged with the rest: build:mac and build:linux on one machine would give
// every tree the building machine's build. The daemon travels as an extra
// resource because it is the same on every target; this one is not.
import { Arch } from "electron-builder";
import { ptyPackage, stagePty } from "./pty.mjs";

export default function afterPack(context) {
  const target = `${context.electronPlatformName}-${Arch[context.arch]}`;
  stagePty(ptyPackage(), context.packager.getResourcesDir(context.appOutDir), target);
  console.log(`staged node-pty for ${target} in ${context.appOutDir}`);
}
