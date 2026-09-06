// SPDX-License-Identifier: AGPL-3.0-only
// Whether one absolute path sits inside another. The engine moves a project's
// agent state by it and the collector weighs a session's folder by it, so it
// lives here rather than in either of them.

/** Whether path is the folder itself or sits inside it; a sibling that shares the prefix is not. */
export function underProject(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}
