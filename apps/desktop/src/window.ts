// SPDX-License-Identifier: AGPL-3.0-only
import { DESKTOP_MAC_CLASS } from "@wsp/protocol";
import type { BrowserWindowConstructorOptions } from "electron";
import { bundleHover } from "./get-bundle.js";
import { shellArg } from "./shell-args.js";

/** How one platform frames the app window: the BrowserWindow options beyond the size and title every
 * platform shares, and the class the page carries so the web lays itself out for that frame. */
interface WindowFrame {
  readonly options: BrowserWindowConstructorOptions;
  readonly htmlClass?: string;
}

const STOCK: WindowFrame = { options: { backgroundColor: "#09090b" } };

/** The material a Mac window stands on while its page draws glass: macOS draws it once for the whole window. */
const MAC_VIBRANCY = "sidebar";

/** The window's own glass for what the page draws: macOS's material while the page draws glass, none while every
 * surface is solid, and nothing to set where the platform has none. */
export function vibrancyFor(platform: NodeJS.Platform, glass: boolean): typeof MAC_VIBRANCY | null | undefined {
  if (platform !== "darwin") return undefined;
  return glass ? MAC_VIBRANCY : null;
}

// The lights' ink measures 14px tall on screen and the header row is 52px; y 19 puts their centre on the row's, at 26,
// and x 16 is where Finder puts them. No tabbingIdentifier: native tabs would take ctrl+tab and the digit chords at the
// window level, and the page switches workspaces with them.
const MAC: WindowFrame = {
  options: {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 19 },
    vibrancy: MAC_VIBRANCY,
    visualEffectState: "followWindow",
    backgroundColor: "#00000000",
  },
  htmlClass: DESKTOP_MAC_CLASS,
};

const FRAMES: Partial<Record<NodeJS.Platform, WindowFrame>> = { darwin: MAC };

export function windowOptions(platform: NodeJS.Platform, version: string, preload?: string): BrowserWindowConstructorOptions {
  const frame = FRAMES[platform] ?? STOCK;
  const hover = bundleHover(platform);
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
      additionalArguments: [shellArg("version", version), ...(frame.htmlClass !== undefined ? [shellArg("html-class", frame.htmlClass)] : []), ...(hover !== undefined ? [shellArg("bundle-hover", hover)] : [])],
    },
  };
}
