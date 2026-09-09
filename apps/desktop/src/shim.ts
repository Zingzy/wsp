// SPDX-License-Identifier: AGPL-3.0-only
// The wsp command the app installs: a shell script that runs this app's own
// binary as node on the command the bundle carries. Electron's binary is node
// once ELECTRON_RUN_AS_NODE is set, so the person needs no Node of their own.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { shellQuote } from "@wsp/protocol";

export interface ShimTarget {
  /** The app's executable, which runs as node. */
  execPath: string;
  /** The bundled command entry the executable runs. */
  script: string;
}

export function shimText(target: ShimTarget): string {
  return `#!/bin/sh\n# The wsp app writes this on each launch; it runs the wsp the app bundles.\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(target.execPath)} ${shellQuote(target.script)} "$@"\n`;
}

/** Writes the shim at `path`, executable, unless one already says exactly this; a shim naming an app that moved is
 * rewritten. Says which happened. */
export function installShim(path: string, text: string): "written" | "kept" {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return "kept";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o755 });
  return "written";
}
