// SPDX-License-Identifier: AGPL-3.0-only
// The one address rule the app and the terminal share: which workspace a page
// opens on, and which thread of it. wsp init writes the workspace form after
// its first fork so the app lands there rather than on whatever the list
// happens to sort first; a thread row's copy-link action writes the thread form.

const PREFIX = "#w/";
const THREAD = "/t/";

/** The hash that opens the app on a workspace. */
export const workspaceHash = (workspaceId: string): string => `${PREFIX}${encodeURIComponent(workspaceId)}`;

/** The hash that opens the app on one thread of a workspace. */
export const threadHash = (workspaceId: string, threadId: string): string => `${workspaceHash(workspaceId)}${THREAD}${encodeURIComponent(threadId)}`;

function parts(hash: string): { workspace: string; thread: string | undefined } | undefined {
  if (!hash.startsWith(PREFIX)) return undefined;
  const rest = hash.slice(PREFIX.length);
  const cut = rest.indexOf(THREAD);
  const workspace = decodeURIComponent(cut === -1 ? rest : rest.slice(0, cut));
  if (workspace === "") return undefined;
  const thread = cut === -1 ? undefined : decodeURIComponent(rest.slice(cut + THREAD.length));
  return { workspace, thread: thread === "" ? undefined : thread };
}

/** The workspace a hash names, or nothing: every other hash is the app's own (#gallery) or none at all. */
export function workspaceFromHash(hash: string): string | undefined {
  return parts(hash)?.workspace;
}

/** The thread a hash names with its workspace, or nothing for a hash that names a workspace alone or nothing. */
export function threadFromHash(hash: string): { workspaceId: string; threadId: string } | undefined {
  const found = parts(hash);
  return found?.thread === undefined ? undefined : { workspaceId: found.workspace, threadId: found.thread };
}
