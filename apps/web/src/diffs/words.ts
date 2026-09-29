// SPDX-License-Identifier: AGPL-3.0-only
// The Changes pane's own words, written here so the pane and its tests read one spelling.

/** The button that hands a pass of line comments to the thread's composer. */
export const SEND_TO_THREAD = "Send to thread";

/** The commit box: its button, its field, the line while a message is drafted, and the one said while the thread's
 * agent still works in the copy. */
export const COMMIT_WORDS = {
  button: "Commit",
  field: "Commit message",
  drafting: "Drafting a message",
  cancel: "Cancel",
  agentWorking: "The agent is still working",
  tick: (file: string): string => `Commit ${file}`,
  committed: (subject: string): string => `Committed ${subject}`,
} as const;

/** Putting one file back: the row's control, the confirmation's title and its line, and the button that does it. */
export const DISCARD_WORDS = {
  control: (file: string): string => `Discard changes to ${file}`,
  title: (file: string): string => `Discard changes to ${file}?`,
  note: "This cannot be undone.",
  deletes: (file: string): string => `No commit has ${file}, so discarding deletes it. This cannot be undone.`,
  confirm: "Discard",
  cancel: "Cancel",
} as const;

/** Editing a file inside the pane, and the one reason a file is not edited here. */
export const EDIT_WORDS = {
  edit: (file: string): string => `Edit ${file}`,
  save: (file: string): string => `Save ${file}`,
  cancel: (file: string): string => `Stop editing ${file}`,
  lineEndings: "This file's line endings are not edited here yet.",
} as const;

/** A file marked viewed, and how many of the list are. */
export const VIEWED_WORDS = {
  tick: (file: string): string => `Viewed ${file}`,
  count: (viewed: number, of: number): string => `${viewed} of ${of} viewed`,
} as const;

/** The scope picker's name for one turn's changes, opened off a reply. */
export const TURN_SCOPE = "This turn";
/** What a file missing from a turn's range has none of. */
export const TURN_NOUN = "changes in this turn";

/** The pane's line for a turn whose snapshot git has since pruned. */
export const SNAPSHOT_GONE = "The snapshot for this turn is gone";
