// SPDX-License-Identifier: AGPL-3.0-only
// The pull request's buttons and heads in the app, one word for each act wherever it shows: the pane, the thread's
// row and the composer's branch line say the same. The state words themselves are the protocol's.
import type { MergeMethod } from "@wsp/protocol";

export const PR_WORDS = {
  /** One word for sending a failed check or a conflict to the agent, everywhere (the coordinator's ruling). */
  fix: "Ask your agent to fix",
  update: (base: string): string => `Update from ${base}`,
  merge: "Merge",
  mergeWhenChecksPass: "Merge when checks pass",
  row: (n: number): string => `Pull request #${n}`,
  number: (n: number): string => `#${n}`,
  sendToThread: "Send to thread",
  refresh: "Refresh",
  reading: "Reading the pull request",
  heads: { checks: "Checks", review: "Review", comments: "Comments", timeline: "Timeline" },
  commented: "commented",
  committed: "committed",
  noDescription: "No description",
} as const;

/** Each method as its menu item reads it. */
export const METHOD_WORDS: Record<MergeMethod, string> = {
  merge: "Merge commit",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};
