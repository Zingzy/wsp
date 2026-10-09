// SPDX-License-Identifier: AGPL-3.0-only
// The two desktop downloads and which one a visitor is shown first. The names
// and the URLs come from the release job's own formatter, so a rename there
// moves these links with it and nothing on this page can go stale.
import { useSyncExternalStore } from "react";
import { downloadUrl, STABLE_NAMES } from "../../../packages/protocol/src/bundles.mjs";

export type Platform = "mac" | "linux" | "windows";

export const DOWNLOADS: Record<Exclude<Platform, "windows">, { label: string; href: string }> = {
  mac: { label: "Download for Mac", href: downloadUrl(STABLE_NAMES.mac) },
  linux: { label: "Download for Linux", href: downloadUrl(STABLE_NAMES.appImage) },
};

/** Which download to put first. Mac against Linux is the one thing a browser answers reliably; the chip is not, since
 * Safari on an M-series Mac reports an Intel one, and one bundle covers both chips so nothing has to ask. Windows has
 * no build yet, so it gets the waitlist. A phone and anything else get the Mac button. */
export function platformOf(userAgent: string): Platform {
  if (/Android/i.test(userAgent)) return "mac";
  if (/Windows/i.test(userAgent)) return "windows";
  return /Linux|X11|CrOS/i.test(userAgent) ? "linux" : "mac";
}

const fixed = () => () => {};

/** The visitor's platform once the page runs in their browser. The prerendered page is the Mac's, so hydration matches
 * it first and a Linux or Windows visitor's buttons switch right after. */
export function useVisitor(): Platform {
  return useSyncExternalStore(fixed, () => platformOf(navigator.userAgent), (): Platform => "mac");
}
