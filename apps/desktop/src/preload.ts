// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentHere, InstallReport } from "@wsp/host";
import type { BundleOutcome, ContextMenuItem, DesktopBridge, HostOutcome, HostsView, LinkTarget, LocalFontFace, OutsideLine, ShellChord, ThemePreference } from "@wsp/protocol";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { RendererError } from "./app-log.js";
import { shellArgFrom } from "./shell-args.js";

/** What the first launch's page can ask the shell, answered only while that page is up. */
export interface OnboardingBridge {
  /** The name this computer's owner gave it, which every sentence on the page names it by. */
  here(): Promise<string>;
  /** The catalog's agents as this computer has them, from the recipe scan's own detector. */
  agents(): Promise<AgentHere[]>;
  /** Writes the wsp server and skill into each named agent's own config. */
  install(ids: string[]): Promise<InstallReport>;
  /** Records this computer as the workspace and opens the app on it; the page's window closes once the app's is up. */
  finish(): Promise<void>;
}

/** One of the page's colour tokens in #rrggbb, the one spelling Electron's colour parser reads for every theme: the
 * token resolves on an element of the page, and its oklch or color-mix on a canvas pixel as the page paints it.
 * Nothing for a clear or unresolved colour. */
function hexOf(token: string): string | undefined {
  const probe = document.createElement("span");
  probe.style.color = `var(${token}, transparent)`;
  document.documentElement.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  const pen = document.createElement("canvas").getContext("2d");
  if (pen === null) return undefined;
  // A colour the canvas cannot parse leaves the fill as it was, so the fill starts clear.
  pen.fillStyle = "transparent";
  pen.fillStyle = color;
  pen.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = pen.getImageData(0, 0, 1, 1).data;
  return a === 0 ? undefined : `#${[r, g, b].map(n => n.toString(16).padStart(2, "0")).join("")}`;
}

const bridge: DesktopBridge & OnboardingBridge = {
  version: shellArgFrom(process.argv, "version"),
  bundleHover: shellArgFrom(process.argv, "bundle-hover"),
  updatesInPlace: shellArgFrom(process.argv, "update-in-place") === "1",
  updateWhy: shellArgFrom(process.argv, "update-why"),
  here: (): Promise<string> => ipcRenderer.invoke("onboarding:here"),
  agents: () => ipcRenderer.invoke("onboarding:agents"),
  install: (ids: string[]): Promise<InstallReport> => ipcRenderer.invoke("onboarding:install", ids),
  finish: () => ipcRenderer.invoke("onboarding:finish"),
  hostToken: (): Promise<string | undefined> => ipcRenderer.invoke("hosts:token"),
  hosts: (): Promise<HostsView> => ipcRenderer.invoke("hosts:list"),
  switchHost: (alias: string | null): Promise<HostOutcome> => ipcRenderer.invoke("hosts:switch", alias),
  getBundle: (ask: { version: string }): Promise<BundleOutcome> => ipcRenderer.invoke("bundle:get", ask),
  quitAndOpen: (): Promise<BundleOutcome> => ipcRenderer.invoke("bundle:open"),
  discardUpdate: (): Promise<BundleOutcome> => ipcRenderer.invoke("bundle:discard"),
  localFonts: (family: string): Promise<LocalFontFace[]> => ipcRenderer.invoke("fonts:local", family),
  fontFamilies: (): Promise<string[]> => ipcRenderer.invoke("fonts:families"),
  pickFolder: (): Promise<string | undefined> => ipcRenderer.invoke("folder:pick"),
  // Answered here rather than over a handler, since only the preload can read the path off a dropped file; the
  // shell is asked first, so a page served by a host somewhere else is handed nothing from this computer.
  droppedPath: (file: File): string | undefined => (ipcRenderer.sendSync("drop:allowed") === true ? webUtils.getPathForFile(file) : undefined),
  contextMenu: (items: ContextMenuItem[]): Promise<string | null> => ipcRenderer.invoke("menu:context", items),
  capturePreview: (workspaceId: string, bounded?: boolean): Promise<void> => ipcRenderer.invoke("preview:capture", workspaceId, bounded === true),
  workspacePreview: (workspaceId: string): Promise<string | undefined> => ipcRenderer.invoke("preview:read", workspaceId),
  setTerminalFocus: (focused: boolean): void => ipcRenderer.send("terminal:focus", focused),
  onShellChord: (handler: (chord: ShellChord) => void): (() => void) => {
    const listen = (_event: unknown, chord: ShellChord): void => handler(chord);
    ipcRenderer.on("shell:chord", listen);
    return () => ipcRenderer.off("shell:chord", listen);
  },
  setTheme: (theme: ThemePreference): void => ipcRenderer.send("theme:set", theme),
  setGlass: (glass: boolean): void => ipcRenderer.send("glass:set", glass),
  setTitleBar: (): void => {
    const color = hexOf("--titlebar-ground");
    const symbolColor = hexOf("--titlebar-ink");
    if (color !== undefined && symbolColor !== undefined) ipcRenderer.send("titlebar:set", { color, symbolColor });
  },
  sayOutside: (line: OutsideLine): void => ipcRenderer.send("outside:say", line),
  setBadge: (count: number): void => ipcRenderer.send("badge:set", count),
  openLogs: (): Promise<void> => ipcRenderer.invoke("logs:open"),
  loginStart: (): Promise<boolean | null> => ipcRenderer.invoke("service:login"),
  setLoginStart: (on: boolean): Promise<boolean | null> => ipcRenderer.invoke("service:login-set", on),
  onOpen: (handler: (target: LinkTarget) => void): (() => void) => {
    const listen = (_event: unknown, target: LinkTarget): void => handler(target);
    ipcRenderer.on("shell:open", listen);
    return () => ipcRenderer.off("shell:open", listen);
  },
  onNeedsYouOpen: (handler: (id?: string) => void): (() => void) => {
    // The id the page put on the line that was clicked, handed back as the page said it.
    const listen = (_event: unknown, id?: string): void => handler(id);
    ipcRenderer.on("needs-you:open", listen);
    return () => ipcRenderer.off("needs-you:open", listen);
  },
};

contextBridge.exposeInMainWorld("wsp", bridge);

// The preload's own world never hears what the page's world throws, so the listeners are set in the page's world and
// hand each report back across the bridge.
const reportError = (report: RendererError): void => ipcRenderer.send("log:renderer", report);
contextBridge.executeInMainWorld({
  func: (report: (r: RendererError) => void): void => {
    const route = (): string => `${location.pathname}${location.hash}`;
    const stackOf = (e: unknown): string | undefined => (e instanceof Error ? e.stack : undefined);
    addEventListener("error", e => report({ kind: "error", message: e.message, stack: stackOf(e.error) ?? "", route: route() }));
    addEventListener("unhandledrejection", e => report({ kind: "rejection", message: e.reason instanceof Error ? e.reason.message : String(e.reason), stack: stackOf(e.reason) ?? "", route: route() }));
  },
  args: [reportError],
});

const htmlClass = shellArgFrom(process.argv, "html-class");
if (htmlClass !== undefined) {
  // The preload runs before the parser has made the html element, so the class waits for it.
  new MutationObserver((_, observer) => {
    if (document.documentElement === null) return;
    document.documentElement.classList.add(htmlClass);
    observer.disconnect();
  }).observe(document, { childList: true });
}
