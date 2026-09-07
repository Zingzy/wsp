// SPDX-License-Identifier: AGPL-3.0-only
import type { DesktopBridge, LocalFontFace } from "@wsp/protocol";
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
  capturePreview: (workspaceId: string): Promise<void> => ipcRenderer.invoke("preview:capture", workspaceId),
  workspacePreview: (workspaceId: string): Promise<string | undefined> => ipcRenderer.invoke("preview:read", workspaceId),
};

contextBridge.exposeInMainWorld("wsp", bridge);
