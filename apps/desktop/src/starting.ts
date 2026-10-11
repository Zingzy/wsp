// SPDX-License-Identifier: AGPL-3.0-only
// What a launch shows while wsp starts and when it could not: a starting window once the open takes a moment, and a
// failed start as one line with a button to the log. Electron stays outside, so both read the same in a test.
import { existsSync } from "node:fs";
import type { MessageBoxOptions } from "electron";
import { StartFailed } from "./host-lifecycle.js";

/** How long an open runs before the starting window shows: an open that attaches to a host already up is quicker. */
export const STARTING_SHOWN_MS = 800;

/** Shows the starting state once `afterMs` has passed, unless ended first; `end` takes it away. The caller ends it
 * once the app's own window stands, or once a failed start's dialog is answered, so a window stands the whole time:
 * on Linux and Windows the last window closing quits the app. */
export function startingAfter(show: () => () => void, afterMs = STARTING_SHOWN_MS): { end(): void } {
  let hide: (() => void) | undefined;
  const timer = setTimeout(() => (hide = show()), afterMs);
  return {
    end: () => {
      clearTimeout(timer);
      hide?.();
      hide = undefined;
    },
  };
}

/** The buttons a failed start offers, Open log first. */
export const OPEN_LOG = 0;
export const QUIT = 1;

/** The dialog for a failed start and the log its button opens: the failure's own line, never the log's lines, which
 * the app's log keeps. The log is the host's where the failure names it, else the host's where one was written, else
 * the app's own. */
export function startFailedDialog(title: string, e: unknown, logs: { host: string; app: string }): { options: MessageBoxOptions; logPath: string } {
  const message = e instanceof Error ? e.message : String(e);
  const line = message.split("\n").find(l => l.trim() !== "")?.trim() ?? title;
  const logPath = e instanceof StartFailed ? e.logPath : existsSync(logs.host) ? logs.host : logs.app;
  return {
    options: { type: "error", message: title, detail: line, buttons: ["Open log", "Quit"], defaultId: OPEN_LOG, cancelId: QUIT, noLink: true },
    logPath,
  };
}

/** Shows that dialog, opens the log when Open log is pressed and quits when Quit is: a later open that failed on a Mac
 * has no window left whose closing would quit the app. */
export async function sayStartFailed(
  title: string,
  e: unknown,
  logs: { host: string; app: string },
  ui: { show(options: MessageBoxOptions): Promise<{ response: number }>; open(path: string): Promise<string>; quit(): void },
): Promise<void> {
  const { options, logPath } = startFailedDialog(title, e, logs);
  const { response } = await ui.show(options);
  if (response === OPEN_LOG) await ui.open(logPath);
  if (response === QUIT) ui.quit();
}
