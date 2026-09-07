// SPDX-License-Identifier: AGPL-3.0-only
import { DESKTOP_MAC_CLASS } from "@wsp/protocol";

/** Whether this page is the macOS desktop window's, whose header row is the window's frame and whose sidebar shows its glass. */
export const isDesktopMac = (): boolean => typeof document !== "undefined" && document.documentElement.classList.contains(DESKTOP_MAC_CLASS);
