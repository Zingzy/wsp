// SPDX-License-Identifier: AGPL-3.0-only
import { DESKTOP_MAC_CLASS, DESKTOP_WCO_CLASS } from "@wsp/protocol";
import type { BrowserWindowConstructorOptions, TitleBarOverlayOptions } from "electron";
import { bundleHover } from "./get-bundle.js";
import { shellArg } from "./shell-args.js";

/** How one platform frames the app window: the BrowserWindow options beyond the size and title every
 * platform shares, the class the page carries so the web lays itself out for that frame, and whether the shell
 * sets its menu bar there. */
interface WindowFrame {
  readonly options: BrowserWindowConstructorOptions;
  readonly htmlClass?: string;
  readonly menu?: false;
}

/** The window's opening ground, dark until the page says otherwise, as the page itself opens. */
const DARK_GROUND = "#09090b";

const STOCK: WindowFrame = { options: { backgroundColor: DARK_GROUND } };

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

/** The header row's height, which the window controls Electron draws over the page match. */
const HEADER_HEIGHT = 52;

// Electron draws no menu bar in a window with a hidden title bar (root_view.cc returns before it builds one), so on
// Linux a menu would only register its accelerators, which take a chord before the page sees it (zoom.ts hands the
// zoom keys back for that reason): ctrl+w, ctrl+r and ctrl+a would never reach a focused terminal.
const LINUX: WindowFrame = {
  options: { titleBarStyle: "hidden", titleBarOverlay: { color: DARK_GROUND, height: HEADER_HEIGHT }, backgroundColor: DARK_GROUND },
  htmlClass: DESKTOP_WCO_CLASS,
  menu: false,
};

/** Every other Linux desktop keeps its own frame: a tiling compositor draws nothing over it, and a stacking one the
 * list has not met (Openbox, IceWM) draws the title bar the window is moved and closed by. The menu stays off: in this
 * frame it would draw the Mac strip, and its accelerators would take a terminal's Control chords. */
const LINUX_OWN_FRAME: WindowFrame = { ...STOCK, menu: false };

/** The Linux desktops that draw a title bar over a window, as XDG_CURRENT_DESKTOP names them. Electron draws its
 * controls over a frameless window on every compositor, so only these get them. */
const TITLE_BAR_DESKTOPS: ReadonlySet<string> = new Set(["gnome", "kde", "xfce", "x-cinnamon", "cinnamon", "mate", "unity", "budgie", "pantheon", "lxqt", "lxde", "deepin", "cosmic"]);

/** XDG_SESSION_DESKTOP names the session file a display manager started, not the desktop: these are the files of the
 * listed desktops whose names are not the desktop's own. */
const SESSION_DESKTOPS: Readonly<Record<string, string>> = {
  plasma: "KDE",
  plasmax11: "KDE",
  plasmawayland: "KDE",
  ubuntu: "GNOME",
  "ubuntu-xorg": "GNOME",
  "ubuntu-wayland": "GNOME",
  "gnome-xorg": "GNOME",
  "gnome-wayland": "GNOME",
  "gnome-classic": "GNOME",
  "budgie-desktop": "Budgie",
};

/** The desktop session's names, colon separated as XDG_CURRENT_DESKTOP lists them ("ubuntu:GNOME"), else the desktop
 * the started session file belongs to. */
export function desktopOf(env: NodeJS.ProcessEnv): string | undefined {
  const current = env["XDG_CURRENT_DESKTOP"];
  if (current) return current;
  const session = env["XDG_SESSION_DESKTOP"];
  return session ? (SESSION_DESKTOPS[session.toLowerCase()] ?? session) : undefined;
}

/** Whether the desktop draws title bars, so a window that hides its own needs the controls drawn over its header. */
export function drawsTitleBar(desktop: string | undefined): boolean {
  return (desktop ?? "").split(":").some(name => TITLE_BAR_DESKTOPS.has(name.trim().toLowerCase()));
}

const FRAMES: Partial<Record<NodeJS.Platform, (desktop: string | undefined) => WindowFrame>> = {
  darwin: () => MAC,
  linux: desktop => (drawsTitleBar(desktop) ? LINUX : LINUX_OWN_FRAME),
};

const frameOf = (platform: NodeJS.Platform, desktop: string | undefined): WindowFrame => FRAMES[platform]?.(desktop) ?? STOCK;

/** Whether the shell sets its menu bar on this platform; where it does not, it sets none, which also takes away
 * the default menu Electron would set in its place. */
export function setsMenu(platform: NodeJS.Platform): boolean {
  return frameOf(platform, undefined).menu !== false;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** The window controls' ground and ink in the colours the page's header row draws in, where the shell draws them
 * over the page; nothing where it does not, or for a colour that is not #rrggbb, the one spelling the preload sends. */
export function titleBarOverlayFor(platform: NodeJS.Platform, desktop: string | undefined, colors: unknown): TitleBarOverlayOptions | undefined {
  if (frameOf(platform, desktop).options.titleBarOverlay === undefined) return undefined;
  if (typeof colors !== "object" || colors === null) return undefined;
  const { color, symbolColor } = colors as { color?: unknown; symbolColor?: unknown };
  if (typeof color !== "string" || typeof symbolColor !== "string" || !HEX.test(color) || !HEX.test(symbolColor)) return undefined;
  return { color, symbolColor, height: HEADER_HEIGHT };
}

/** How this app takes a release: replaced where it runs, or the disk image road with the reason it cannot be. */
export interface UpdateRoad {
  inPlace: boolean;
  why?: string;
}

export function windowOptions(platform: NodeJS.Platform, version: string, preload?: string, update: UpdateRoad = { inPlace: false }, desktop?: string): BrowserWindowConstructorOptions {
  const frame = frameOf(platform, desktop);
  const hover = bundleHover(platform, update.inPlace);
  return {
    width: 1280,
    height: 800,
    title: "wsp",
    ...frame.options,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // A browser tab's guest; the shell's will-attach-webview gate decides which page may make one and how it runs.
      webviewTag: true,
      ...(preload !== undefined ? { preload } : {}),
      additionalArguments: [
        shellArg("version", version),
        ...(frame.htmlClass !== undefined ? [shellArg("html-class", frame.htmlClass)] : []),
        ...(hover !== undefined ? [shellArg("bundle-hover", hover)] : []),
        ...(update.inPlace ? [shellArg("update-in-place", "1")] : []),
        ...(update.why !== undefined ? [shellArg("update-why", update.why)] : []),
      ],
    },
  };
}
