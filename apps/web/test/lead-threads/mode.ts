// SPDX-License-Identifier: AGPL-3.0-only
// Which composer the page draws, read once off the address so the app's own modules this page swaps can ask it
// without importing the prototype's components: ?around=proposed draws the proposed one (children as live tiles where
// they were started, the Threads block moved into the composer's one drawer, every folded thing a row of that drawer)
// and anything else today's.
export const PROPOSED = new URLSearchParams(window.location.search).get("around") === "proposed";

export const proposedComposer = (): boolean => PROPOSED;

/** The child a tool call started, where it is a wsp run or fork the fixture named by the child it started; the build
 * reads the thread id off the call's own answer. Null for every other call, and always under today's composer. */
export const spawnedBy = (entry: { readonly toolCallId?: string | undefined }): string | null =>
  PROPOSED && entry.toolCallId?.startsWith("spawn_") === true ? entry.toolCallId.slice("spawn_".length) : null;

/** The subagent a launching call started, by the fixture's launch id; null under today's composer. */
export const launchedBy = (parentToolUseId: string): string | null => (PROPOSED && parentToolUseId.startsWith("launch_") ? parentToolUseId.slice("launch_".length) : null);

/** The child a timeline entry started, where it is a wsp run or fork or an Agent call; null for every other entry. */
export const spawnKeyOf = (entry: { readonly kind: string; readonly entry?: { readonly toolCallId?: string | undefined }; readonly subagent?: { readonly parentToolUseId: string } }): string | null =>
  entry.kind === "work" && entry.entry !== undefined ? spawnedBy(entry.entry) : entry.kind === "subagent" && entry.subagent !== undefined ? launchedBy(entry.subagent.parentToolUseId) : null;

/** Whether the page open is a subagent's, asked by modules that hold no store: the page registers the reading. */
let subagentPage: () => boolean = () => false;
export const setSubagentPageCheck = (check: () => boolean): void => {
  subagentPage = check;
};
export const onSubagentPage = (): boolean => subagentPage();
