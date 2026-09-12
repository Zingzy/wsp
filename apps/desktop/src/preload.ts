// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentHere, InstallReport } from "@wsp/host";
import type { ContextMenuItem, DesktopBridge, HostConnectAsk, HostOutcome, HostsView, InitNeedsYou, LocalFontFace, ShellChord, ThemePreference } from "@wsp/protocol";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import { shellArgFrom } from "./shell-args.js";

/** What the first launch's page can ask the shell, answered only while that page is up. */
export interface OnboardingBridge {
  /** The catalog's agents as this computer has them, from the recipe scan's own detector. */
  agents(): Promise<AgentHere[]>;
  /** Writes the wsp server and skill into each named agent's own config. */
  install(ids: string[]): Promise<InstallReport>;
  /** Records this computer as the workspace and opens the app on it; the page's window closes once the app's is up. */
  finish(): Promise<void>;
  /** The same, with the app opened on the road that joins this Mac to another wsp. */
  connect(): Promise<void>;
}

const bridge: DesktopBridge & OnboardingBridge = {
  version: shellArgFrom(process.argv, "version"),
  agents: () => ipcRenderer.invoke("onboarding:agents"),
  install: (ids: string[]): Promise<InstallReport> => ipcRenderer.invoke("onboarding:install", ids),
  finish: () => ipcRenderer.invoke("onboarding:finish"),
  connect: () => ipcRenderer.invoke("onboarding:connect"),
  hostToken: (): Promise<string | undefined> => ipcRenderer.invoke("hosts:token"),
  hosts: (): Promise<HostsView> => ipcRenderer.invoke("hosts:list"),
  switchHost: (alias: string | null): Promise<HostOutcome> => ipcRenderer.invoke("hosts:switch", alias),
  connectHost: (ask: HostConnectAsk): Promise<HostOutcome> => ipcRenderer.invoke("hosts:connect", ask),
  disconnectHost: (alias: string): Promise<HostOutcome> => ipcRenderer.invoke("hosts:disconnect", alias),
  onConnectHostOpen: (handler: () => void): (() => void) => {
    const listen = (): void => handler();
    ipcRenderer.on("hosts:connect-open", listen);
    return () => ipcRenderer.off("hosts:connect-open", listen);
  },
  localFonts: (family: string): Promise<LocalFontFace[]> => ipcRenderer.invoke("fonts:local", family),
  pickFolder: (): Promise<string | undefined> => ipcRenderer.invoke("folder:pick"),
  droppedPath: (file: File): string => webUtils.getPathForFile(file),
  contextMenu: (items: ContextMenuItem[]): Promise<string | null> => ipcRenderer.invoke("menu:context", items),
  capturePreview: (workspaceId: string): Promise<void> => ipcRenderer.invoke("preview:capture", workspaceId),
  workspacePreview: (workspaceId: string): Promise<string | undefined> => ipcRenderer.invoke("preview:read", workspaceId),
  setTerminalFocus: (focused: boolean): void => ipcRenderer.send("terminal:focus", focused),
  onShellChord: (handler: (chord: ShellChord) => void): (() => void) => {
    const listen = (_event: unknown, chord: ShellChord): void => handler(chord);
    ipcRenderer.on("shell:chord", listen);
    return () => ipcRenderer.off("shell:chord", listen);
  },
  setTheme: (theme: ThemePreference): void => ipcRenderer.send("theme:set", theme),
  needsYou: (need: InitNeedsYou): void => ipcRenderer.send("needs-you:say", need),
  onNeedsYouOpen: (handler: () => void): (() => void) => {
    const listen = (): void => handler();
    ipcRenderer.on("needs-you:open", listen);
    return () => ipcRenderer.off("needs-you:open", listen);
  },
};

contextBridge.exposeInMainWorld("wsp", bridge);

const htmlClass = shellArgFrom(process.argv, "html-class");
if (htmlClass !== undefined) {
  // The preload runs before the parser has made the html element, so the class waits for it.
  new MutationObserver((_, observer) => {
    if (document.documentElement === null) return;
    document.documentElement.classList.add(htmlClass);
    observer.disconnect();
  }).observe(document, { childList: true });
}
