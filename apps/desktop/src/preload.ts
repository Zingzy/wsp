// SPDX-License-Identifier: AGPL-3.0-only
import type { ContextMenuItem, DesktopBridge, LocalFontFace } from "@wsp/protocol";
import { contextBridge, ipcRenderer } from "electron";

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
};

contextBridge.exposeInMainWorld("wsp", bridge);
