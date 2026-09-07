// SPDX-License-Identifier: AGPL-3.0-only
// Names that mean a cache, an install or Finder metadata: what a machine
// recreates and a copy never carries. The project bundle and the nap-time
// vault skip these.

/** Directories a machine recreates, by exact name: installs, build output and tool caches. A directory is a cache only
 * when its whole name is on this list; a file never is, whatever its name, since a source file called lruCache.ts is
 * source. The list is spelled once here and read by the local walk and the guest's find alike. */
export const CACHE_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".pnpm-store",
  "venv",
  ".venv",
  "virtenv",
  "site-packages",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".cache",
  ".parcel-cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".gradle",
]);
/** Finder's per-directory metadata, a file by exact name; it means nothing on a Linux machine. */
export const FINDER_METADATA = ".DS_Store";
