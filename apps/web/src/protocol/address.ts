// SPDX-License-Identifier: AGPL-3.0-only
// The window's side of the app's address: what this page names now, and the
// writing of what the person is reading back into it. The address is the one
// record of that, so it is replaced rather than pushed: a pick inside the app
// is not a page to go back from, and a back step would leave the app showing
// one thread while the address named another. The shape lives in the protocol.
import { addressFromHash, appHash, type AppAddress } from "@wsp/protocol";

/** What this page's address names, or nothing on a page whose hash names no workspace. */
export function readAddress(): AppAddress | undefined {
  return typeof window === "undefined" ? undefined : addressFromHash(window.location.hash);
}

/** Writes what the person is reading into the address; null leaves the page with no address at all. */
export function writeAddress(address: AppAddress | null): void {
  if (typeof window === "undefined") return;
  const hash = address === null ? "" : appHash(address);
  if (window.location.hash === hash) return;
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${hash}`);
}

/** The whole link to an address, which is what a person pastes elsewhere. */
export const addressLink = (address: AppAddress): string => `${window.location.origin}${window.location.pathname}${appHash(address)}`;
