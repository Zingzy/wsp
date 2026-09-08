// SPDX-License-Identifier: AGPL-3.0-only
// node-pty is the one package the desktop bundle leaves external, so it is the
// one package the stage lays out beside the bundle. Its loader requires
// pty.node by a path relative to its own lib and resolves spawn-helper from
// __dirname, neither of which survives being inlined into build/app/main.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** node-pty's runtime files under <appDir>/node_modules, with a native build under prebuilds/<platform>-<arch> for
 * every arch of this platform the package is built for. That is the second of the two directories node-pty's loader
 * looks in; the first, build/Release, answers for whichever arch compiled it, so a source build is copied to the arch
 * it was built for rather than left where a two-arch mac package's other arch would load it. Only this platform's
 * prebuilds travel: the windows ones carry 50 MB of debug symbols no mac or linux app can run. Throws when this
 * machine has no build for itself, since the alternative is a package whose terminal panes die at the dial. */
export function stagePty(from, appDir) {
  const out = join(appDir, "node_modules", "node-pty");
  const here = `${process.platform}-${process.arch}`;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(from, "package.json"), join(out, "package.json"));
  // node-pty's mocha files ride in its lib, and one of them requires a package the app has not got.
  cpSync(join(from, "lib"), join(out, "lib"), { recursive: true, filter: p => !p.endsWith(".test.js") && !p.endsWith(".map") });
  const prebuilds = join(from, "prebuilds");
  const shipped = existsSync(prebuilds) ? readdirSync(prebuilds).filter(t => t.startsWith(`${process.platform}-`)) : [];
  for (const target of shipped) cpSync(join(prebuilds, target), join(out, "prebuilds", target), { recursive: true });
  const compiled = join(from, "build", "Release", "pty.node");
  if (!existsSync(join(out, "prebuilds", here, "pty.node")) && existsSync(compiled)) {
    mkdirSync(join(out, "prebuilds", here), { recursive: true });
    cpSync(compiled, join(out, "prebuilds", here, "pty.node"));
  }
  if (!existsSync(join(out, "prebuilds", here, "pty.node"))) throw new Error(`node-pty has no build for ${here} under ${from}`);
  return out;
}
