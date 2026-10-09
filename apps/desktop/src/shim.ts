// SPDX-License-Identifier: AGPL-3.0-only
// The wsp command the app installs: a shell script that runs this app's own
// binary as node on the command the bundle carries. Electron's binary is node
// once ELECTRON_RUN_AS_NODE is set, so the person needs no Node of their own.
// Where the bundle carries the daemon binary, the script runs its forwarder in
// front of that command, so every agent's `wsp mcp` rides the host already
// running rather than holding a node process of its own for the whole session.
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { defaultHomeIn, shimPath } from "@wsp/host";
import { compareVersions, shellQuote } from "@wsp/protocol";

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
 * rewritten. A fresh file is renamed over whatever stands there, so a link left at the path is replaced and never
 * written through. Says which happened. */
export function installShim(path: string, text: string): "written" | "kept" {
  if (!isLink(path) && existsSync(path) && readFileSync(path, "utf8") === text) return "kept";
  mkdirSync(dirname(path), { recursive: true });
  const part = `${path}.${process.pid}.part`;
  writeFileSync(part, text, { mode: 0o755 });
  renameSync(part, path);
  return "written";
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
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

/** Where npm puts a global install's package, from the folder holding its bin link: `<prefix>/bin/wsp` points into
 * `<prefix>/lib/node_modules/@wsp-labs/wsp`. */
const NPM_PACKAGE = ["..", "lib", "node_modules", "@wsp-labs", "wsp"];

const inside = (path: string, dir: string): boolean => path.startsWith(`${dir}${sep}`);

/** The release an installed @wsp-labs/wsp package says it is, read off its package.json and never by running it. */
function packageRelease(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    return pkg.name === "@wsp-labs/wsp" && typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/** Makes every npm global install's `wsp` link on `path` of an earlier release than `release` a link to the shim, so
 * the wsp a shell finds runs this app whatever order its PATH comes in: the owner's ~/.local/bin/wsp was one, and it
 * started an old host beside a newer app. A wsp is ours by where its link points, never by what it prints: a file
 * (a person's wrapper, the wsp a host writes on a machine), a link anywhere else, a later release and a folder PATH
 * names relative to wherever the app started all stay. Only the app on the person's own home touches PATH, read off
 * the password file and not HOME, since a test or a lab on another home would point their real wsp into a folder that
 * goes. Says a line for each wsp it replaced or left. */
export function replaceOlderOnPath(home: string, path: string, release: string, defaultHome: string = defaultHomeIn(userInfo().homedir)): string[] {
  if (resolve(home) !== resolve(defaultHome)) return [];
  const shim = shimPath(home);
  const lines: string[] = [];
  for (const dir of new Set(path.split(":").filter(dir => isAbsolute(dir)))) {
    const file = join(dir, "wsp");
    let target: string;
    try {
      if (!lstatSync(file).isSymbolicLink()) {
        if (file !== shim) lines.push(`${file} is a file of its own, not npm's link to wsp, so it stays`);
        continue;
      }
      target = resolve(dir, readlinkSync(file));
    } catch {
      continue;
    }
    if (inside(target, dirname(shim))) continue;
    const pkg = resolve(dir, ...NPM_PACKAGE);
    const theirs = inside(target, pkg) ? packageRelease(pkg) : undefined;
    if (theirs === undefined) {
      lines.push(`${file} points at ${target}, not an npm install of wsp, so it stays`);
      continue;
    }
    if (compareVersions(theirs, release) >= 0) {
      if (theirs !== release) lines.push(`${file} is wsp ${theirs}, later than this app's ${release}, so it stays`);
      continue;
    }
    const part = join(dir, `.wsp.${process.pid}.part`);
    try {
      rmSync(part, { force: true });
      symlinkSync(shim, part);
      renameSync(part, file);
      lines.push(`${file} was npm's wsp ${theirs}; it now runs ${shim}, wsp ${release}`);
    } catch (e) {
      rmSync(part, { force: true });
      lines.push(`${file} is npm's wsp ${theirs} and could not be replaced (${e instanceof Error ? e.message : String(e)}); remove it so a shell finds wsp ${release}`);
    }
  }
  return lines;
}
