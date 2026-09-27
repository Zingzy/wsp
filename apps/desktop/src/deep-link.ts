// SPDX-License-Identifier: AGPL-3.0-only
// The wsp:// links the system hands the shell: macOS by open-url, Linux and
// Windows as an argument to a second launch. Any app on the computer can hand
// the shell one, so a link is read down to the kind and id it names and the
// page is told only that; the page opens what it names and never acts on it.
// A link that arrives before the window has a page is held and carried in as
// the first page's hash. A window on a host somewhere else is moved home
// first, since that host's page is never told anything of this computer's.
import { addressFromLink, linkHash, type LinkTarget } from "@wsp/protocol";

export interface LinkDeps {
  /** The window's page as it stands, or nothing before the app window's first page is up. */
  page(): { readonly remote: boolean } | undefined;
  /** Tells the page on the app's own host what a link names. */
  send(target: LinkTarget): void;
  /** Puts the window back on the app's own host, opened at the hash. */
  moveHome(hash: string): Promise<void>;
  /** Brings the window in front of the person. */
  raise(): void;
}

export interface DeepLinks {
  open(url: string): void;
  /** The hash the first page opens at, for the link held until then; taken once. */
  take(): string;
  /** The first page is up: a link that arrived while it loaded is sent now. */
  ready(): void;
}

export function deepLinks(deps: LinkDeps): DeepLinks {
  let held: LinkTarget | undefined;
  const deliver = (target: LinkTarget, page: { readonly remote: boolean }): void => {
    deps.raise();
    if (page.remote) void deps.moveHome(linkHash(target));
    else deps.send(target);
  };
  return {
    open(url) {
      const target = addressFromLink(url);
      if (target === undefined) return;
      const page = deps.page();
      if (page === undefined) held = target;
      else deliver(target, page);
    },
    take() {
      const hash = held === undefined ? "" : linkHash(held);
      held = undefined;
      return hash;
    },
    ready() {
      const page = deps.page();
      if (held === undefined || page === undefined) return;
      const target = held;
      held = undefined;
      deliver(target, page);
    },
  };
}

/** The wsp:// link among a launch's arguments, where the system put one. */
export const linkInArgv = (argv: readonly string[]): string | undefined => argv.find(arg => arg.slice(0, 6).toLowerCase() === "wsp://");
