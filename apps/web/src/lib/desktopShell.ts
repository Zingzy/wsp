// SPDX-License-Identifier: AGPL-3.0-only
// Which shell holds the page. The desktop shell's preload puts its bridge on
// the window; a browser tab has none of it, so the bridge's presence is the
// one reading of "this is the desktop app" the page has. On macOS the preload
// also marks the html element: the window has no title bar of its own there,
// the header row is its frame and the sidebar shows its glass. On Linux it
// marks it too: the header row is the frame, with the window controls drawn
// over its right end, and every surface stays solid.
import { DESKTOP_MAC_CLASS, DESKTOP_WCO_CLASS, type DesktopBridge } from "@wsp/protocol";

declare global {
  interface Window {
    wsp?: Partial<DesktopBridge>;
  }
}

export function desktopBridge(): Partial<DesktopBridge> | undefined {
  return typeof window === "undefined" ? undefined : window.wsp;
}

export function isDesktopShell(): boolean {
  return desktopBridge() !== undefined;
}

export function isDesktopMac(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains(DESKTOP_MAC_CLASS);
}

/** Whether the window has no title bar of its own, so the header row is its frame and the place it is dragged by. */
export function headerIsWindowFrame(): boolean {
  return typeof document !== "undefined" && (isDesktopMac() || document.documentElement.classList.contains(DESKTOP_WCO_CLASS));
}
