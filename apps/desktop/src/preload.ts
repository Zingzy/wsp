// SPDX-License-Identifier: AGPL-3.0-only
import type { DesktopBridge, LocalFontFace } from "@wsp/protocol";
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
