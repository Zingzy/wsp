// SPDX-License-Identifier: AGPL-3.0-only
// The pull request's buttons and heads in the app, one word for each act wherever it shows: the pane, the thread's
// row and the composer's branch line say the same. The state words themselves are the protocol's; the ink each one
// wears is here, as GitHub draws them: open and approved green, closed, failed and conflicts red, merged violet,
// changes asked for amber, a draft muted, and the running dot pulses.
import { pullRequestKey, pullRequestWord, type CheckState, type MergeMethod, type PullRequestKey, type PullRequestSeen } from "@wsp/protocol";
import type { Tone } from "./conversation.logic.js";

export const PR_WORDS = {
  /** One word for sending a failed check or a conflict to the agent, everywhere. */
  fix: "Ask your agent to fix",
  update: (base: string): string => `Update from ${base}`,
  merge: "Merge",
  mergeWhenChecksPass: "Merge when checks pass",
  row: (n: number): string => `Pull request #${n}`,
  number: (n: number): string => `#${n}`,
  sendToAgent: (agent: string): string => `Send to ${agent}`,
  sendAll: "Send to agent",
  refresh: "Refresh",
  heads: { draft: "Draft review", status: "Status", activity: "Activity" },
  tabs: { conversation: "Conversation", commits: "Commits", files: "Files" },
  showMore: "Show more",
  showLess: "Show less",
  opened: (ago: string): string => `opened ${ago}`,
  sent: (ago: string): string => `Sent ${ago}`,
  /** Who wrote it where GitHub names no account, which is one deleted since. */
  deletedAccount: "a deleted account",
  cut: { commits: "Showing the first 100 commits", reviews: "Showing the latest 100 reviews", threads: "Showing the latest 100 review threads" },
  leftNotice: "left a notice",
  show: "Show",
  hide: "Hide",
  reviewAskedOf: "Review asked of",
  reviewRequired: "Review required",
  /** What holds the merge, the first that holds. */
  hold: {
    conflicts: "Held until the conflicts are fixed",
    checks: "Held until the checks pass",
    draft: "Held while it is a draft",
    review: "Held until a review approves it",
    unknown: "GitHub is still working out whether it merges",
    ready: "Ready to merge",
  },
  unresolved: (n: number, word: "unresolved" | "unsent"): string => `${n} ${word}`,
  mergedBy: "Merged by",
  landedAs: (base: string): string => `Landed on ${base} as`,
  mergesWhenChecksPass: (method: MergeMethod): string => `Merges ${AUTO_METHOD_WORDS[method]} when checks pass`,
  failedAfter: (workflow: string | undefined, took: string): string => (workflow === undefined ? `failed after ${took}` : `${workflow}, failed after ${took}`),
  runningFor: (took: string): string => `running ${took}`,
  reviewed: "reviewed",
  commented: "commented",
  commentedOnLine: "commented on a line",
  pushed: (n: number): string => (n === 1 ? "pushed a commit" : `pushed ${n} commits`),
  noCommits: "No commits yet",
  noFiles: "No files changed",
  noDiff: "GitHub sent no diff for this file",
  noDiffRead: "This host does not read a pull request's diff",
  diffCut: "The diff was cut at 2 MB before this file",
  files: (n: number): string => `${n} ${n === 1 ? "file" : "files"}`,
  expandFolders: "Expand all folders",
  collapseFolders: "Collapse all folders",
  openInChanges: "Open in Changes",
  openOnGitHub: "Open on GitHub",
  checks: "Checks",
  review: "Review",
  comments: "Comments",
  behind: (n: number): string => `${n} ${n === 1 ? "commit" : "commits"} behind`,
  conflicts: "Conflicts",
  merged: "Merged",
  closedNotMerged: "Closed, not merged",
  noDescription: "No description.",
  replyTo: (who: string): string => `Reply to ${who}`,
  reply: "Reply",
  resolve: "Resolve",
  unresolve: "Unresolve",
  resolved: "Resolved",
  commentCount: (n: number): string => (n === 1 ? "1 comment" : `${n} comments`),
  cancel: "Cancel",
  send: "Send",
  addReaction: "Add a reaction",
} as const;

/** Each check state as the merge box's checks line counts it. */
export const CHECK_COUNT_WORDS: Record<CheckState, string> = { pass: "passed", fail: "failed", pending: "running", skipped: "skipped", cancelled: "cancelled" };

/** Each method as its menu item reads it. */
export const METHOD_WORDS: Record<MergeMethod, string> = {
  merge: "Merge commit",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

/** How an armed merge says its method. */
const AUTO_METHOD_WORDS: Record<MergeMethod, string> = { squash: "by squash", rebase: "by rebase", merge: "with a merge commit" };

/** How long something took, as a row says it: "16 min", "1 h 5 min", "40 s". */
export function spanWord(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
}

/** The ink each tone is drawn in, off the theme's own status tokens. */
export const TONE_INK: Record<Tone, string> = {
  ok: "text-status-done",
  bad: "text-status-failed",
  warn: "text-warning-foreground",
  run: "text-status-working",
  merged: "text-pr-merged",
  quiet: "text-muted-foreground",
};

/** The tone each place a pull request stands in wears. */
const KEY_TONE: Record<PullRequestKey, Tone> = { merged: "merged", closed: "bad", conflicts: "bad", failed: "bad", running: "run", changesAsked: "warn", approved: "ok", draft: "quiet", open: "ok", unread: "quiet" };

/** The pull request's one word with the tone it wears; hollow for a draft and for one that could not be read. */
export function pullRequestTone(seen: PullRequestSeen): { word: string; tone: Tone; hollow: boolean } {
  const key = pullRequestKey(seen);
  return { word: pullRequestWord(seen), tone: KEY_TONE[key], hollow: key === "draft" || key === "unread" };
}

/** An author as the pane names them: their login, or a deleted account where GitHub names none. */
export function authorName(login: string): string {
  return login.trim() === "" ? PR_WORDS.deletedAccount : login;
}

/** A relative time as a sentence says it, the figure apart from its unit: "3 h ago". */
export function spacedAgo(ago: string): string {
  return ago.replace(/^(\d+)([a-z]+)\b/, "$1 $2");
}
