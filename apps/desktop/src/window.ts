// SPDX-License-Identifier: AGPL-3.0-only
// The one window's constructor options. No tabbingIdentifier: macOS native
// tabs bind ctrl+tab and the digit chords at the window level, and the page
// needs them for the workspace switch. This shell is the only one where those
// chords reach a page at all, since a browser tab keeps them.
import type { BrowserWindowConstructorOptions } from "electron";

export function appWindowOptions(preload?: string): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 800,
    title: "wsp",
    backgroundColor: "#09090b",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      ...(preload !== undefined ? { preload } : {}),
    },
  };
}
