// SPDX-License-Identifier: AGPL-3.0-only
// The browser tab's guest pages. A guest is anyone's web page, so it runs in a
// session of its own, never the window's, which holds the host page and its
// token, and it runs sandboxed, isolated and with no preload whatever the page
// that made it asked for. Only the app's own host's page may make one: the
// page holding a guest can script it, and the guest session keeps the person's
// sign-ins. A new window a guest asks for becomes a new tab, and a link to
// another app asks before it leaves.
import { BROWSER_PARTITION, type GuestOpen } from "@wsp/protocol";

/** The parts of a guest's web preferences the gate reads and sets. */
export interface GuestPreferences {
  partition?: string;
  preload?: string;
  sandbox?: boolean;
  contextIsolation?: boolean;
  nodeIntegration?: boolean;
  nodeIntegrationInSubFrames?: boolean;
  webSecurity?: boolean;
}

/** Whether a guest may attach, setting its preferences to the only ones a guest runs with. The partition read is the
 * one the guest would get: a webpreferences attribute naming another one lands here too. */
export function attachGuest(prefs: GuestPreferences): boolean {
  if (prefs.partition !== BROWSER_PARTITION) return false;
  delete prefs.preload;
  prefs.sandbox = true;
  prefs.contextIsolation = true;
  prefs.nodeIntegration = false;
  prefs.nodeIntegrationInSubFrames = false;
  prefs.webSecurity = true;
  return true;
}

function schemeOf(url: string): string | undefined {
  try {
    return new URL(url).protocol;
  } catch {
    return undefined;
  }
}

/** Schemes that open nothing outside: this computer's files, script and the browser's own pages. */
const STAYS_IN = new Set(["file:", "javascript:", "data:", "blob:", "about:", "chrome:", "devtools:", "filesystem:"]);

/** What a guest's ask for a new window becomes: a web page opens in a new tab, another app's link asks first, and
 * anything else goes nowhere. */
export function guestWindow(url: string): "tab" | "ask" | "drop" {
  const scheme = schemeOf(url);
  if (scheme === "http:" || scheme === "https:") return "tab";
  return scheme === undefined || STAYS_IN.has(scheme) ? "drop" : "ask";
}

/** What a guest page is granted without a word: nothing that reaches this computer's camera, microphone, location or
 * notifications. */
const GRANTED: ReadonlySet<string> = new Set(["fullscreen", "clipboard-sanitized-write", "pointerLock"]);

export const LEAVE_WORDS = {
  message: (url: string) => `Open ${url} in another app?`,
  detail: "A page in the browser tab wants to leave wsp.",
  open: "Open",
  cancel: "Cancel",
} as const;

/** The shell around the guests, a fake under test. */
export interface GuestShell {
  /** Whether the page at this url may hold guests. */
  mayHold(pageUrl: string): boolean;
  /** Hands a guest's new window to the page holding it. */
  newTab(open: GuestOpen): void;
  /** Asks the person whether a link may leave for another app. */
  ask(url: string): Promise<boolean>;
  openOutside(url: string): void;
}

/** The parts of Electron's guest WebContents this needs. */
export interface GuestContents {
  id: number;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
}

/** The parts of the guest session this needs. */
export interface GuestSession {
  setPermissionRequestHandler(handler: (contents: unknown, permission: string, callback: (granted: boolean) => void, details: object) => void): void;
  setPermissionCheckHandler(handler: (contents: unknown, permission: string) => boolean): void;
}

async function leave(shell: GuestShell, url: string): Promise<boolean> {
  const yes = await shell.ask(url).catch(() => false);
  if (yes) shell.openOutside(url);
  return yes;
}

/** Set once on the guest session: a link to another app, which Chromium hands over as the openExternal permission,
 * asks first, and every other permission is the short list's. */
export function guardGuestSession(session: GuestSession, shell: GuestShell): void {
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    if (permission !== "openExternal") return callback(GRANTED.has(permission));
    const url = (details as { externalURL?: unknown }).externalURL;
    if (typeof url !== "string") return callback(false);
    void shell.ask(url).then(callback, () => callback(false));
  });
  session.setPermissionCheckHandler((_contents, permission) => GRANTED.has(permission));
}

/** The listeners each window that loads a host page sets on its contents: a guest attaches only while the window's
 * page may hold guests and only on their own partition, and a guest's new window becomes a tab of the page's or a
 * question. The window's own page is the only one that can make a guest: a frame inside it has no webview element. */
export function guestGuards(page: { getURL(): string }, shell: GuestShell) {
  return {
    willAttach(event: { preventDefault(): void }, prefs: GuestPreferences): void {
      if (!shell.mayHold(page.getURL()) || !attachGuest(prefs)) event.preventDefault();
    },
    didAttach(_event: unknown, guest: GuestContents): void {
      guest.setWindowOpenHandler(({ url }) => {
        const road = guestWindow(url);
        if (road === "tab") shell.newTab({ guest: guest.id, url });
        else if (road === "ask") void leave(shell, url);
        return { action: "deny" };
      });
    },
  };
}
