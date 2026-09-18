// SPDX-License-Identifier: AGPL-3.0-only
// The line that stages the daemon binary this wsp needs beside it, one row per
// road a wsp is installed by, read off the process this wsp is running as. The
// binary is not built by any node build, so a host rebuilt without it runs
// beside the one that was there before; every sentence about a daemon that is
// behind on this computer carries this line as its fix.
import { sep } from "node:path";
import type { RunningWsp } from "./mcp-install.js";

/** The published package, as an install line names it. */
const NPM_PACKAGE = "@zingzy/wsp";

/** The line that puts the right daemon beside this wsp, by the road this one was installed by: a bin under a
 * global node_modules is an npm install and takes the install line again; a bin inside the desktop app's bundle
 * moves with the app, so the app's own update is the road; anything else is a checkout, where the binary comes
 * from a cargo build placed by the script that stages it. */
export function daemonFixLine(run: Pick<RunningWsp, "argv" | "shim">): string {
  const path = run.shim ?? run.argv[1] ?? "";
  const parts = path.split(sep);
  if (parts.includes("node_modules")) return `npm i -g ${NPM_PACKAGE}`;
  if (parts.some(part => part.endsWith(".app"))) return "updating the wsp app";
  return "a cargo build of the daemon and node packages/wspx/scripts/daemon-binary.mjs --from its binary";
}
