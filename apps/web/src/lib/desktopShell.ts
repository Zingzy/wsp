// SPDX-License-Identifier: AGPL-3.0-only
// Which shell holds the page. The desktop shell's preload puts its bridge on
// the window; a browser tab has none of it, so the bridge's presence is the
// one reading of "this is the desktop app" the page has.
import type { DesktopBridge } from "@wsp/protocol";

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
