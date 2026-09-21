// SPDX-License-Identifier: AGPL-3.0-only
// The session every frame in the window shares: the host's page and the
// preview pane's frames alike. A page a person previews is served by a process
// inside a workspace, on a loopback port the kernel picked and hands out again
// once the forward is dropped, and a service worker that page registers
// outlives both; the next page on that number, another workspace's preview or
// a host page with its token, would be that worker's to answer. So no frame on
// a loopback origin registers one, and a host page is never loaded into a
// session still holding one an earlier build let in. The cost is named where
// the person meets it: a preview in this window runs no service worker, and
// the chrome row's Open in browser is where one that needs one goes.
import { isLoopback } from "@wsp/protocol";

/** The request header a browser puts on a worker script fetch and on its update, and on nothing else; the filter's
 * own type list has no word for one, so the listener reads the header itself. */
const WORKER_SCRIPT = { name: "service-worker", value: "script" };

/** The part of Electron's Session this needs; a fake stands in for it under test. */
export interface PageSession {
  webRequest: {
    onBeforeSendHeaders(listener: (details: { url: string; requestHeaders: Record<string, string> }, callback: (response: { cancel?: boolean }) => void) => void): void;
  };
  clearStorageData(options: { storages: ["serviceworkers"] }): Promise<void>;
}

/** The part of a BrowserWindow this needs. */
export interface HostPage {
  webContents: { session: PageSession };
  loadURL(url: string): Promise<void>;
}

function onLoopback(url: string): boolean {
  try {
    return isLoopback(new URL(url).hostname);
  } catch {
    return false;
  }
}

function asksForWorkerScript(headers: Record<string, string>): boolean {
  return Object.entries(headers).some(([name, value]) => name.toLowerCase() === WORKER_SCRIPT.name && value.toLowerCase() === WORKER_SCRIPT.value);
}

/** Installed on the window's session once, before the window's first load: a worker script fetch on a loopback
 * origin is cancelled, and every other request passes untouched. */
export function guardWorkers(session: PageSession): void {
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    callback(onLoopback(details.url) && asksForWorkerScript(details.requestHeaders) ? { cancel: true } : {});
  });
}

/** Puts the window on a host's page, with the session's worker registrations swept first: a worker an earlier build
 * let in is gone before a page carrying this computer's token is loaded on an origin it could hold. */
export async function loadHostPage(page: HostPage, url: string): Promise<void> {
  await page.webContents.session.clearStorageData({ storages: ["serviceworkers"] });
  await page.loadURL(url);
}
