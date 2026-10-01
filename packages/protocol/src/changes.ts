// SPDX-License-Identifier: AGPL-3.0-only
// The Changes pane's facts and words: the checkout a workspace's tile and composer row read, held by the host and
// pushed on the workspace's status, the answers of its writes, and the question a commit message is drafted from.
import { z } from "zod";
import { wordsWithin } from "./format.js";

/** A copy's checkout as the host last read it: the branch git is on, its counts against its upstream or the default
 * branch, and how many files differ from HEAD. editsUnread is a stopped copy whose branch was read off its files and
 * whose edits were not; countsUnknown is one whose history was too long to walk. readAt is when git answered, so a
 * computer whose link went down shows the last fact for what it is. */
export const Checkout = z.object({
  branch: z.string(),
  ahead: z.number().int(),
  behind: z.number().int(),
  changed: z.number().int(),
  editsUnread: z.boolean().optional(),
  countsUnknown: z.boolean().optional(),
  /** How many stashes the copy holds, work no branch carries; absent where there are none. */
  stashes: z.number().int().positive().optional(),
  /** The commit the checkout is on, which a tile shows where the head is on no branch. */
  head: z.string().optional(),
  readAt: z.number(),
});
export type Checkout = z.infer<typeof Checkout>;

/** One word table for the counts a checkout carries on the composer's checkout row. */
export const CHECKOUT_WORDS = {
  changed: (n: number): string => `${n} changed`,
  unread: "changes not read",
} as const;

/** The count that follows a branch on the composer's row: what the checkout holds uncommitted, a zero left out, and a
 * copy whose edits were not read saying so in place of a count it does not have. How far the branch is ahead of or
 * behind anything is not said there; Update from main in the pane is how a person acts on behind. */
export function checkoutCounts(c: Pick<Checkout, "changed" | "editsUnread">): string[] {
  if (c.editsUnread === true) return [CHECKOUT_WORDS.unread];
  return c.changed > 0 ? [CHECKOUT_WORDS.changed(c.changed)] : [];
}

/** What workspaces.checkout answers: the fact as the host holds it, absent where git has never answered. */
export const CheckoutReply = z.object({ checkout: Checkout.optional() });
export type CheckoutReply = z.infer<typeof CheckoutReply>;

/** A drafted message, or none with the one line that says why. */
export const CommitDraft = z.object({ message: z.string().nullable(), note: z.string().optional() });
export type CommitDraft = z.infer<typeof CommitDraft>;

/** Every file a person marked viewed in a workspace, by path, against the blob id its contents had then. */
export const ViewedMarks = z.object({ viewed: z.record(z.string(), z.string()) });
export type ViewedMarks = z.infer<typeof ViewedMarks>;

/** The most of a diff a draft carries: past it the question costs more than the answer is worth. */
export const DRAFT_DIFF_MAX_BYTES = 48 * 1024;

/** A diff cut to the bytes given at its last line end inside them, as the daemon cuts a patch: never through a letter. */
export function cutDiff(text: string, max: number = DRAFT_DIFF_MAX_BYTES): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return text;
  const head = bytes.subarray(0, max);
  const nl = head.lastIndexOf(10);
  return new TextDecoder().decode(nl > 0 ? head.subarray(0, nl + 1) : head).replace(/�+$/, "");
}

/** How much of the task a draft carries: the words a change is for are at the top of a brief. */
const DRAFT_TASK_MAX = 2000;

/** The one question every harness is asked for a commit message, on its own CLI with no thread and no tool, from the
 * diff and the task the workspace's thread was opened with. */
export function draftPrompt(diff: string, task?: string): string {
  const said = task?.trim();
  return [
    "Write a git commit message for the changes in the diff below.",
    "The first line is the subject: under 72 characters, sentence case, no full stop, saying what the change does.",
    "Then one blank line, then two to five lines saying why the change was made, in plain words.",
    "No em dashes, no bullet points, no markdown and no quotes around the message.",
    "Answer with the message alone and nothing else.",
    ...(said === undefined || said === "" ? [] : ["", "The task the agent was given:", said.length <= DRAFT_TASK_MAX ? said : said.slice(0, DRAFT_TASK_MAX)]),
    "",
    "The diff:",
    diff,
  ].join("\n");
}

/** The longest subject a drafted message keeps; a longer one is cut to the words that fit. */
const SUBJECT_MAX = 72;

/** A harness's answer to draftPrompt as a commit message, or none when it answered nothing: a fence or quotes around
 * the message come off, an em dash becomes a comma, the subject is cut to the words that fit, and the body follows
 * one blank line. */
export function commitMessage(answer: string): string | null {
  let text = answer.trim().replace(/^```[^\n]*\n([\s\S]*?)\n?```$/, "$1").trim();
  const quoted = /^(["'“‘])([\s\S]*)(["'”’])$/.exec(text);
  if (quoted !== null) text = quoted[2]!.trim();
  text = text.replace(/\s*\u2014\s*/g, ", ");
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex(line => line.trim() !== "");
  if (at < 0) return null;
  const first = lines[at]!.trim();
  const subject = first.length <= SUBJECT_MAX ? first : (wordsWithin(first, SUBJECT_MAX) ?? first.slice(0, SUBJECT_MAX));
  const body = lines.slice(at + 1).join("\n").trim();
  return body === "" ? subject : `${subject}\n\n${body}`;
}

/** What `wsp discard` says once a file is back as HEAD has it. */
export function discardedLine(workspace: string, path: string): string {
  return `${workspace}: ${path} discarded`;
}

/** What a commit of every change says when the checkout has none. */
export function cleanCheckoutLine(workspace: string): string {
  return `${workspace}: nothing to commit, the checkout has no changes`;
}

/** What `wsp commit` says once the commit stands: the short id and the subject. */
export function committedLine(workspace: string, commit: { oid: string; subject: string; filesChanged: number }): string {
  return `${workspace}: committed ${commit.oid.slice(0, 7)} ${commit.subject} (${commit.filesChanged} file${commit.filesChanged === 1 ? "" : "s"})`;
}

/** Why a draft came back empty, as the one line the commit box shows under it. */
export const DRAFT_NOTES = {
  noAgent: "No agent here drafts commit messages; write it yourself.",
  noAnswer: "The agent did not draft a message; write it yourself.",
  nothing: "Nothing is ticked to draft a message from.",
} as const;
