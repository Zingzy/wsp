// SPDX-License-Identifier: AGPL-3.0-only
// Whether one absolute path sits inside another, and where a daemon's roots
// file sits. The engine moves a project's agent state by the first and the
// collector weighs a session's folder by it; the host and the guest constant
// both read the second, so neither rule lives in either of them. Paths are
// joined here rather than through node:path: this package is bundled into the
// browser and imports nothing outside itself.

/** Whether path is the folder itself or sits inside it; a sibling that shares the prefix is not. */
export function underProject(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** The file naming the imported project folders a daemon may browse, one absolute path per line. It sits beside the
 * home of whichever daemon reads it: DAEMON_ROOTS_PATH is this answered for a guest, whose home is /root, and this
 * computer's own daemon answers it for the person's home. */
export function rootsPathIn(home: string): string {
  return `${home.replace(/\/+$/, "")}/.wsp/roots`;
}
