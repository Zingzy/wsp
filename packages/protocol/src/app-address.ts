// SPDX-License-Identifier: AGPL-3.0-only
// The one address rule the app and the terminal share: which workspace a page
// opens on. wsp init writes it after its first fork so the app lands there
// rather than on whatever the list happens to sort first.

const PREFIX = "#w/";

/** The hash that opens the app on a workspace. */
export const workspaceHash = (workspaceId: string): string => `${PREFIX}${encodeURIComponent(workspaceId)}`;

/** The workspace a hash names, or nothing: every other hash is the app's own (#gallery) or none at all. */
export function workspaceFromHash(hash: string): string | undefined {
  if (!hash.startsWith(PREFIX)) return undefined;
  const id = decodeURIComponent(hash.slice(PREFIX.length));
  return id === "" ? undefined : id;
}
