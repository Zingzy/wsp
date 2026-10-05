// SPDX-License-Identifier: AGPL-3.0-only
// The wsp command the app installs: a shell script that runs this app's own
// binary as node on the command the bundle carries. Electron's binary is node
// once ELECTRON_RUN_AS_NODE is set, so the person needs no Node of their own.
// Where the bundle carries the daemon binary, the script runs its forwarder in
// front of that command, so every agent's `wsp mcp` rides the host already
// running rather than holding a node process of its own for the whole session.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { shellQuote } from "@wsp/protocol";

export interface ShimTarget {
  /** The app's executable, which runs as node. */
  execPath: string;
  /** The bundled command entry the executable runs. */
  script: string;
  /** The daemon binary the bundle carries for this computer, whose forwarder goes in front; absent where it carries none. */
  daemon?: string;
}

export function shimText(target: ShimTarget): string {
  const wsp = `${shellQuote(target.execPath)} ${shellQuote(target.script)}`;
  const line = target.daemon === undefined ? wsp : `${shellQuote(target.daemon)} forward --wsp-argv ${shellQuote(target.execPath)} --wsp-argv ${shellQuote(target.script)} --`;
  return `#!/bin/sh\n# The wsp app writes this on each launch; it runs the wsp the app bundles.\nELECTRON_RUN_AS_NODE=1 exec ${line} "$@"\n`;
}

/** Writes the shim at `path`, executable, unless one already says exactly this; a shim naming an app that moved is
 * rewritten. Says which happened. */
export function installShim(path: string, text: string): "written" | "kept" {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return "kept";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o755 });
  return "written";
}

/** The AppImage this launch runs from: the folder its runtime mounted for this launch alone, the image file itself,
 * and the app's version. */
export interface AppImageLaunch {
  appdir: string;
  image: string;
  version: string;
}

/** The target moved out of an AppImage's mount, which goes when the launch that made it ends, into a copy under the
 * wsp home that the command and the service can run after it. One copy per image file, named by the version and the
 * file's size and time so a rebuilt image of one version is copied again; the copy is made whole beside its place and
 * renamed in. The copy made before it stays, since the service's host may still run it until its next start; any
 * older one goes, and a host still running one stops once its program is gone. */
export function keepAppImage(target: ShimTarget, launch: AppImageLaunch, home: string): ShimTarget {
  const image = statSync(launch.image);
  const name = `${launch.version}-${createHash("sha256").update(`${image.size}:${image.mtimeMs}`).digest("hex").slice(0, 8)}`;
  const root = join(home, "app");
  const kept = join(root, name);
  if (!existsSync(kept)) {
    const part = `${kept}.${process.pid}.part`;
    rmSync(part, { recursive: true, force: true });
    cpSync(launch.appdir, part, { recursive: true, verbatimSymlinks: true });
    renameSync(part, kept);
  }
  const others = readdirSync(root)
    .filter(other => other !== name)
    .map(other => ({ other, made: statSync(join(root, other)).mtimeMs }))
    .sort((a, b) => b.made - a.made);
  const before = others.find(({ other }) => !other.endsWith(".part"))?.other;
  for (const { other } of others) if (other !== before) rmSync(join(root, other), { recursive: true, force: true });
  const moved = (path: string): string => join(kept, relative(launch.appdir, path));
  return { execPath: moved(target.execPath), script: moved(target.script), ...(target.daemon !== undefined ? { daemon: moved(target.daemon) } : {}) };
}
