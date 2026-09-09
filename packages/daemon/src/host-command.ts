// SPDX-License-Identifier: AGPL-3.0-only
// How this computer's own modules run the small commands they read it with.

/** The person's environment with the locale pinned: df, ps and vm_stat all print dates, numbers and column headers
 * the parsers here read, and a login's own locale moves all three. Built per call, not once at load, because the
 * environment a command inherits is whatever the host holds when it runs. */
export function cLocale(): { env: NodeJS.ProcessEnv } {
  return { env: { ...process.env, LC_ALL: "C" } };
}
