// SPDX-License-Identifier: AGPL-3.0-only
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("wsp", {
  retry: (): Promise<boolean> => ipcRenderer.invoke("setup:retry"),
});
