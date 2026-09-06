// SPDX-License-Identifier: AGPL-3.0-only
// Names that mean a cache, an install or Finder metadata: what a machine
// recreates and a copy never carries. The project bundle skips these.

/** Directories an install recreates, under a home or in a project; never copied. */
export const INSTALL_NAMES: ReadonlySet<string> = new Set(["node_modules", "venv", ".venv", "virtenv", "site-packages", "__pycache__"]);
/** What a project's own tooling regenerates: build output, coverage, framework and task-runner caches. */
export const OUTPUT_NAMES: ReadonlySet<string> = new Set(["dist", "build", "out", "target", "coverage", ".next", ".nuxt", ".turbo", ".tox", ".gradle"]);
/** Finder's per-directory metadata; it means nothing on a Linux machine. */
export const FINDER_METADATA = /^\.DS_Store$/;
/** A name that says cache, wherever the word sits: .cache, .eslintcache, .parcel-cache, __pycache__. */
export const CACHE_WORD = /cache/i;
