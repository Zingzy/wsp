// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentHere, AgentSessions, InstallReport } from "@wsp/host";
import type { ContextMenuItem, DesktopBridge, LocalFontFace, ShellChord, ThemePreference } from "@wsp/protocol";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import { htmlClassFrom } from "./html-class.js";

/** What the first launch's page can ask the shell, answered only while that page is up. */
export interface OnboardingBridge {
  /** The catalog's agents as this computer has them, and whether the app carries each one's mark. */
  agents(): Promise<Array<AgentHere & { glyph: boolean }>>;
  /** How many sessions each named agent's store holds; read apart from the rows, since the stores take a while. */
  history(ids: string[]): Promise<AgentSessions[]>;
  /** Writes the wsp server and skill into each named agent's own config. */
  install(ids: string[]): Promise<InstallReport>;
  /** Records this computer as the workspace and opens the app on it; the page's window closes once the app's is up. */
  finish(): Promise<void>;
}

const bridge: DesktopBridge & OnboardingBridge = {
  agents: () => ipcRenderer.invoke("onboarding:agents"),
  history: (ids: string[]): Promise<AgentSessions[]> => ipcRenderer.invoke("onboarding:history", ids),
  install: (ids: string[]): Promise<InstallReport> => ipcRenderer.invoke("onboarding:install", ids),
  finish: () => ipcRenderer.invoke("onboarding:finish"),
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
};

contextBridge.exposeInMainWorld("wsp", bridge);

const htmlClass = htmlClassFrom(process.argv);
if (htmlClass !== undefined) {
  // The preload runs before the parser has made the html element, so the class waits for it.
  new MutationObserver((_, observer) => {
    if (document.documentElement === null) return;
    document.documentElement.classList.add(htmlClass);
    observer.disconnect();
  }).observe(document, { childList: true });
}
