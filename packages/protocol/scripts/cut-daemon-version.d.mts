// SPDX-License-Identifier: AGPL-3.0-only
// What cut-daemon-version.mjs hands a TypeScript reader; the landing runs the
// module itself as plain JavaScript.
/** Every file the cut reads or writes, relative to the repo. */
export const CUT_PATHS: { record: string; rust: string; fixture: string; note: string };
/** The record's entries in order, each as written: a quoted sha, or UNRECORDED. */
export function recordOf(text: string): string[];
/** Cuts the next version where the tree's daemon changed since the last one, and says which version stands. */
export function cutDaemonVersion(repo: string, opts?: { note?: string }): { cut: false; version: number } | { cut: true; version: number; sha: string };
