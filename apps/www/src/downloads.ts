// SPDX-License-Identifier: AGPL-3.0-only
// The two desktop downloads and which one a visitor is shown first. The names
// and the URLs come from the release job's own formatter, so a rename there
// moves these links with it and nothing on this page can go stale.
import { downloadUrl, STABLE_NAMES } from "../../../packages/wspx/scripts/bundles.mjs";

export type Platform = "mac" | "linux";

export const DOWNLOADS: Record<Platform, { label: string; href: string }> = {
  mac: { label: "Download for Mac", href: downloadUrl(STABLE_NAMES.mac) },
  linux: { label: "Download for Linux", href: downloadUrl(STABLE_NAMES.appImage) },
};

export const OTHER: Record<Platform, Platform> = { mac: "linux", linux: "mac" };

/** Which download to put first. Mac against Linux is the one thing a browser answers reliably; the chip is not, since
 * Safari on an M-series Mac reports an Intel one, and one bundle covers both chips so nothing has to ask. A phone and
 * anything else get the Mac button, with Linux beside it and the command line under both. */
export function platformOf(userAgent: string): Platform {
  if (/Android/i.test(userAgent)) return "mac";
  return /Linux|X11|CrOS/i.test(userAgent) ? "linux" : "mac";
}
