// SPDX-License-Identifier: AGPL-3.0-only
// node-pty is the one package the desktop bundle leaves external, so it is the
// one package that has to be laid out beside the bundle. Its loader requires
// pty.node by a path relative to its own lib and resolves spawn-helper from
// __dirname, neither of which survives being inlined into build/app/main.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** The platform-arch this machine is, in the words node-pty names its prebuild directories with, which are node's
 * own. electron-builder's electronPlatformName and Arch enum spell them the same way, so a target and a machine
 * are comparable without a translation table. */
export function hostTarget() {
  return `${process.platform}-${process.arch}`;
}

/** Where node-pty is installed: it is @wsp/daemon's dependency, and pnpm's layout puts it nowhere above
 * apps/desktop, so it is resolved from the daemon's own folder. */
export function ptyPackage() {
  const here = createRequire(import.meta.url);
  return dirname(createRequire(here.resolve("@wsp/daemon/package.json")).resolve("node-pty/package.json"));
}

/** node-pty's runtime files under <appDir>/node_modules, carrying one native build: the one for `target`, under
 * prebuilds/<target>, which is the directory node-pty's loader reads for a process of that platform and arch.
 * Called once per packaged tree, since a tree runs one target and a build makes several of them from one machine.
 *
 * node-pty's own build/Release is never shipped where the loader reads it: the loader tries that directory first and
 * it answers for whichever arch compiled it, so a mac package's other arch would load the wrong one. It is read only
 * as the source for this machine's own target, which is where an install with no prebuild to download compiles to.
 *
 * A target this machine has no build for throws rather than shipping a tree whose panes die at the dial: node-pty's
 * native module only exists for the machine that installed it, so that package has to be built where it runs. */
export function stagePty(from, appDir, target = hostTarget()) {
  const out = join(appDir, "node_modules", "node-pty");
  const shipped = join(from, "prebuilds", target);
  const native = existsSync(shipped) ? shipped : target === hostTarget() ? join(from, "build", "Release") : undefined;
  if (native === undefined || !existsSync(join(native, "pty.node"))) {
    throw new Error(`node-pty has no build for ${target} under ${from}: a package for ${target} has to be built on ${target}`);
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(from, "package.json"), join(out, "package.json"));
  // node-pty's mocha files ride in its lib, and one of them requires a package the app has not got.
  cpSync(join(from, "lib"), join(out, "lib"), { recursive: true, filter: p => !p.endsWith(".test.js") && !p.endsWith(".map") });
  // Debug symbols beside a windows prebuild are 50 MB the app never reads.
  cpSync(native, join(out, "prebuilds", target), { recursive: true, filter: p => !p.endsWith(".pdb") });
  return out;
}
