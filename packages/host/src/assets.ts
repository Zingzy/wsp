// SPDX-License-Identifier: AGPL-3.0-only
// The one table of shipped assets: the built web app the host serves, and the
// @wsp/daemon package the guest bundle is staged from. Each entry says what to
// call it, where a packed command stages it, the file that proves it was built
// and fully copied, which workspace package builds it in a checkout, and how it
// is copied there. npm drops node_modules from a published tarball, so the
// packed road is the only one the published command has; adding an asset is one
// entry here and nothing else.
import { WEB_DIR_ENV } from "@wsp/protocol";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ASSET_KINDS = ["web", "daemon", "cli"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** The folder a packed command stages its assets into, one level above the bundle. */
export const ASSETS_DIR = "assets";

interface Asset {
  /** What a message about it says. */
  name: string;
  /** Its folder under ASSETS_DIR. */
  dir: string;
  /** The file inside it whose absence means it was never built, or the copy never finished. */
  proof: string;
  /** Where it comes from in a checkout. */
  workspace(): string;
  /** Copies it, the folder it was built in to the folder a packed command reads. */
  stage(from: string, to: string): void;
}

const resolveHere = (specifier: string): string => createRequire(import.meta.url).resolve(specifier);

const ASSETS: Record<AssetKind, Asset> = {
  web: {
    name: "web app",
    dir: "web",
    proof: "index.html",
    workspace: () => join(dirname(resolveHere("@wsp/web/package.json")), "dist"),
    stage: (from, to) => cpSync(from, to, { recursive: true }),
  },
  cli: {
    name: "wsp command bundle",
    dir: "cli",
    proof: "dist/bin.js",
    // The published command's own package, which carries every workspace package inside its build: not this
    // package's dist/bin.js, which leaves its imports outside and would need the whole tree beside it on a machine
    // that has none. It travels as npm lays it out, package.json beside dist, since the bin reads its version through
    // that file and announces it in every MCP handshake; dist travels whole because the build is split across chunk
    // files bin.js imports by name.
    workspace: () => join(here(), "..", "..", "wspx"),
    stage: packaged,
  },
  daemon: {
    name: "daemon package",
    dir: "daemon",
    proof: "dist/index.js",
    workspace: () => dirname(resolveHere("@wsp/daemon/package.json")),
    // Its folder in a checkout also holds sources and a node_modules; only what a guest runs travels.
    stage: packaged,
  },
};

/** A package as npm installs it and nothing else: its package.json and its dist, out of a folder that in a checkout
 * also holds sources, tests and a node_modules. */
function packaged(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const part of ["package.json", "dist"]) cpSync(join(from, part), join(to, part), { recursive: true });
}

/** What a message about an asset calls it, so a folder that was never built is named the same wherever it is read. */
export function assetName(kind: AssetKind): string {
  return ASSETS[kind].name;
}

/** The file inside an asset that proves it was built and fully copied. */
export function assetProof(kind: AssetKind): string {
  return ASSETS[kind].proof;
}

/** Where a packed command stages an asset under its package root; what a stage script writes and this file reads. */
export function stagedAsset(packageRoot: string, kind: AssetKind): string {
  return join(packageRoot, ASSETS_DIR, ASSETS[kind].dir);
}

/** Copies an asset out of `from` into the packed layout, refusing a source that was never built. Returns where it went. */
export function stageAsset(from: string, packageRoot: string, kind: AssetKind): string {
  const to = stagedAsset(packageRoot, kind);
  copyAsset(kind, from, to);
  return to;
}

/** Copies an asset the way its own entry says, wherever it is going: the packed layout, or a bundle a machine gets.
 * Refuses a source that was never built, named in the words the table gives the asset. */
export function copyAsset(kind: AssetKind, from: string, to: string): void {
  const asset = ASSETS[kind];
  const proof = join(from, asset.proof);
  if (!existsSync(proof)) throw new Error(`${asset.name} missing: ${proof}`);
  asset.stage(from, to);
}

/** The staged asset for a bundle running out of `fromDir`, or nothing when this is not a packed command or the copy never finished. */
export function packedAsset(fromDir: string, kind: AssetKind): string | undefined {
  const dir = stagedAsset(join(fromDir, ".."), kind);
  return existsSync(join(dir, ASSETS[kind].proof)) ? dir : undefined;
}

/** Where an asset comes from in a checkout: the workspace package that builds it. Stage scripts read it from here. */
export function workspaceAsset(kind: AssetKind): string {
  return ASSETS[kind].workspace();
}

function here(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** An asset for whoever is running: staged beside a packed bundle, else built in this checkout. */
export function assetDir(kind: AssetKind, fromDir: string = here()): string {
  return packedAsset(fromDir, kind) ?? workspaceAsset(kind);
}

/** The folder a host serves the app out of: the one a harness named in the environment, else the asset built or
 * staged beside this command. A harness serves a copy of the app so a build landing while a tester drives it cannot
 * change the page under them. */
export function webDirFor(env: Readonly<Record<string, string | undefined>> = process.env, fromDir?: string): string {
  const said = env[WEB_DIR_ENV];
  return said !== undefined && said !== "" ? said : assetDir("web", fromDir);
}
