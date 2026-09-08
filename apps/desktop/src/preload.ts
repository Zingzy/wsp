// SPDX-License-Identifier: AGPL-3.0-only
import type { ContextMenuItem, DesktopBridge, LocalFontFace, ShellChord, ThemePreference } from "@wsp/protocol";
import { contextBridge, ipcRenderer } from "electron";
import { htmlClassFrom } from "./html-class.js";

export interface Retry {
  ready: boolean;
  home: string;
  stalePointer?: string;
}

const bridge: DesktopBridge & { retry(): Promise<Retry> } = {
  retry: () => ipcRenderer.invoke("setup:retry"),
  localFonts: (family: string): Promise<LocalFontFace[]> => ipcRenderer.invoke("fonts:local", family),
  pickFolder: (): Promise<string | undefined> => ipcRenderer.invoke("folder:pick"),
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
