// SPDX-License-Identifier: AGPL-3.0-only
// The one address rule the app and the host share: which workspace a page
// opens on, which thread of it, and the screen a workspace's next thread is
// written on. The address is the app's one record of what a person is
// reading, so it is written on every pick and read on every refresh; wsp init
// writes the workspace form after its first fork, and a thread row's
// copy-link action the thread form. A wsp:// link the desktop takes from the
// system is read here too, down to the kind and id it names. One writer and
// one reader live here, so no surface grows a parser of its own.

const PREFIX = "#w/";
const THREAD = "/t/";
const NEW = "/new";
/** The pairing code wsp init minted for the browser it opens, as the last segment of the hash: spent on the page's
 * first paint and written back out of the address, so what the person is reading never carries it. */
const CODE = "/c/";
/** The same code on a page opened on no workspace. */
const CODE_ALONE = "#c/";

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

/** The hash wsp init opens the app on: the workspace it made, or none, with the code that lets the browser in. */
export function openingHash(code: string, workspaceId?: string): string {
  return `${workspaceId === undefined ? CODE_ALONE : `${workspaceHash(workspaceId)}${CODE}`}${encodeURIComponent(code)}`;
}

/** The pairing code a hash carries and the hash left once it is taken out, or nothing when it carries none. */
export function pairingCodeOf(hash: string): { code: string; rest: string } | undefined {
  const alone = hash.startsWith(CODE_ALONE);
  const cut = alone ? 0 : hash.startsWith(PREFIX) ? hash.lastIndexOf(CODE) : -1;
  if (cut === -1) return undefined;
  const code = decodeURIComponent(hash.slice(cut + (alone ? CODE_ALONE.length : CODE.length)));
  return code === "" ? undefined : { code, rest: hash.slice(0, cut) };
}

/** What a hash names, or nothing: every other hash is the app's own (#gallery) or none at all. A code riding the
 * end of it is not part of what it names. */
export function addressFromHash(hash: string): AppAddress | undefined {
  const named = pairingCodeOf(hash)?.rest ?? hash;
  if (!named.startsWith(PREFIX)) return undefined;
  const rest = named.slice(PREFIX.length);
  const cut = rest.indexOf(THREAD);
  const fresh = cut === -1 && rest.endsWith(NEW);
  const workspaceId = decodeURIComponent(fresh ? rest.slice(0, -NEW.length) : cut === -1 ? rest : rest.slice(0, cut));
  if (workspaceId === "") return undefined;
  const threadId = cut === -1 ? "" : decodeURIComponent(rest.slice(cut + THREAD.length));
  return { workspaceId, ...(threadId === "" ? {} : { threadId }), ...(fresh ? { fresh: true } : {}) };
}

/** What a wsp:// link can name. A link opens something and never does anything to it: an act a link could start
 * would be one any page or app on the computer could start by handing the shell a url. */
export const LINK_KINDS = ["thread", "workspace", "project", "settings"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];
export interface LinkTarget {
  readonly kind: LinkKind;
  /** The thread's, workspace's or project's id, or the Settings group's. */
  readonly id: string;
}

const LINK_SCHEME = "wsp://";
const LINK_PREFIX = "#open/";
/** An id as wsp mints them: letters, digits, dashes and underscores, nothing a path or a query could hide behind. */
const LINK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function linkTarget(kind: string, id: string): LinkTarget | undefined {
  if (!(LINK_KINDS as readonly string[]).includes(kind) || !LINK_ID.test(id)) return undefined;
  return { kind: kind as LinkKind, id };
}

/** What a wsp:// link names, read as `wsp://<kind>/<id>` and nothing looser: no query, no fragment, no second
 * segment, no escapes. Anything else names nothing. */
export function addressFromLink(url: string): LinkTarget | undefined {
  if (url.slice(0, LINK_SCHEME.length).toLowerCase() !== LINK_SCHEME) return undefined;
  const rest = url.slice(LINK_SCHEME.length);
  const parts = (rest.endsWith("/") ? rest.slice(0, -1) : rest).split("/");
  return parts.length === 2 ? linkTarget(parts[0]!, parts[1]!) : undefined;
}

/** The hash the app is opened on for a link the shell took before the page was up. */
export const linkHash = (target: LinkTarget): string => `${LINK_PREFIX}${target.kind}/${target.id}`;

/** The link a hash carries, or nothing. */
export function linkFromHash(hash: string): LinkTarget | undefined {
  if (!hash.startsWith(LINK_PREFIX)) return undefined;
  const parts = hash.slice(LINK_PREFIX.length).split("/");
  return parts.length === 2 ? linkTarget(parts[0]!, parts[1]!) : undefined;
}
