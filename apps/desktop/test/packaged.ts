// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ptyBuild } from "../scripts/pty.mjs";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

export interface PackagedTree {
  /** The platform-arch the tree's app runs on, in node's own words. */
  target: string;
  /** The tree electron-builder leaves under dist, and the paths inside it. */
  dir: string;
  executable: string;
  resources: string;
}

/** Every tree electron-builder's targets leave behind, from one place: the arch a tree runs on decides which native
 * build has to be in it, and which of them this machine can launch. */
export const PACKAGED_TREES: readonly PackagedTree[] = [
  { target: "darwin-arm64", dir: "mac-arm64", executable: join("wsp.app", "Contents", "MacOS", "wsp"), resources: join("wsp.app", "Contents", "Resources") },
  { target: "darwin-x64", dir: "mac", executable: join("wsp.app", "Contents", "MacOS", "wsp"), resources: join("wsp.app", "Contents", "Resources") },
  { target: "linux-x64", dir: "linux-unpacked", executable: "wsp", resources: "resources" },
];

/** The trees a build left on disk. */
export function packaged(): PackagedTree[] {
  return PACKAGED_TREES.filter(tree => existsSync(join(dist, tree.dir)));
}

/** The tree this machine runs, built or not. */
export function treeHere(): PackagedTree | undefined {
  return PACKAGED_TREES.find(tree => tree.target === `${process.platform}-${process.arch}`);
}

export function executableIn(tree: PackagedTree): string {
  return join(dist, tree.dir, tree.executable);
}

export function resourcesIn(tree: PackagedTree): string {
  return join(dist, tree.dir, tree.resources);
}

/** Where a tree carries node-pty's native build for its own target. */
export function ptyBuildIn(tree: PackagedTree): string {
  return ptyBuild(resourcesIn(tree), tree.target);
}
