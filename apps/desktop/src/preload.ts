// SPDX-License-Identifier: AGPL-3.0-only
import { contextBridge, ipcRenderer } from "electron";

export interface Retry {
  ready: boolean;
  home: string;
  stalePointer?: string;
}

contextBridge.exposeInMainWorld("wsp", {
  retry: (): Promise<Retry> => ipcRenderer.invoke("setup:retry"),
});
