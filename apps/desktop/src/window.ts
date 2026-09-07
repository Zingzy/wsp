// SPDX-License-Identifier: AGPL-3.0-only
import { DESKTOP_MAC_CLASS } from "@wsp/protocol";
import type { BrowserWindowConstructorOptions } from "electron";
import { htmlClassArg } from "./html-class.js";

/** How one platform frames the app window: the BrowserWindow options beyond the size and title every
 * platform shares, and the class the page carries so the web lays itself out for that frame. */
interface WindowFrame {
  readonly options: BrowserWindowConstructorOptions;
  readonly htmlClass?: string;
}

const STOCK: WindowFrame = { options: { backgroundColor: "#09090b" } };

// The lights are 12px tall and the header row 52px; y 20 centres them in it, x 16 is where Finder puts them.
const MAC: WindowFrame = {
  options: {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 20 },
    vibrancy: "sidebar",
    visualEffectState: "followWindow",
    backgroundColor: "#00000000",
  },
  htmlClass: DESKTOP_MAC_CLASS,
};

const FRAMES: Partial<Record<NodeJS.Platform, WindowFrame>> = { darwin: MAC };

export function windowOptions(platform: NodeJS.Platform, preload?: string): BrowserWindowConstructorOptions {
  const frame = FRAMES[platform] ?? STOCK;
  return {
    width: 1280,
    height: 800,
    title: "wsp",
    ...frame.options,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      ...(preload !== undefined ? { preload } : {}),
      ...(frame.htmlClass !== undefined ? { additionalArguments: [htmlClassArg(frame.htmlClass)] } : {}),
    },
  };
}
