// SPDX-License-Identifier: AGPL-3.0-only
// The one address rule the app and the host share: which workspace a page
// opens on, which thread of it, and the screen a workspace's next thread is
// written on. The address is the app's one record of what a person is
// reading, so it is written on every pick and read on every refresh; wsp init
// writes the workspace form after its first fork, and a thread row's
// copy-link action the thread form. One writer and one reader live here, so
// no surface grows a hash parser of its own.

const PREFIX = "#w/";
const THREAD = "/t/";
const NEW = "/new";

/** What a page's address names. */
export interface AppAddress {
  readonly workspaceId: string;
  /** A thread of it, when the address names one. */
  readonly threadId?: string;
  /** Whether it names the screen the workspace's next thread is written on, which has no thread of its own yet. */
  readonly fresh?: boolean;
}

/** The hash that opens the app on a workspace. */
export const workspaceHash = (workspaceId: string): string => `${PREFIX}${encodeURIComponent(workspaceId)}`;

/** The hash for an address: a workspace, one thread of it, or its next thread's screen. */
export function appHash(address: AppAddress): string {
  const base = workspaceHash(address.workspaceId);
  if (address.threadId !== undefined) return `${base}${THREAD}${encodeURIComponent(address.threadId)}`;
  return address.fresh === true ? `${base}${NEW}` : base;
}

/** What a hash names, or nothing: every other hash is the app's own (#gallery) or none at all. */
export function addressFromHash(hash: string): AppAddress | undefined {
  if (!hash.startsWith(PREFIX)) return undefined;
  const rest = hash.slice(PREFIX.length);
  const cut = rest.indexOf(THREAD);
  const fresh = cut === -1 && rest.endsWith(NEW);
  const workspaceId = decodeURIComponent(fresh ? rest.slice(0, -NEW.length) : cut === -1 ? rest : rest.slice(0, cut));
  if (workspaceId === "") return undefined;
  const threadId = cut === -1 ? "" : decodeURIComponent(rest.slice(cut + THREAD.length));
  return { workspaceId, ...(threadId === "" ? {} : { threadId }), ...(fresh ? { fresh: true } : {}) };
}
