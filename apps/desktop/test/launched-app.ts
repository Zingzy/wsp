// SPDX-License-Identifier: AGPL-3.0-only
// What the packaged smoke and the flows share to launch the built app and find its windows.
import type { ElectronApplication, Page } from "playwright";
import { vi } from "vitest";
import { writeStub } from "../../../packages/protocol/test/stub-script.js";
import { builtExecutableHere } from "./packaged.js";

/** The app a case launches: the one WSP_DESKTOP_APP names, else the tree a build left for this machine. */
export function builtApp(): string {
  const fromEnv = process.env["WSP_DESKTOP_APP"];
  if (fromEnv !== undefined) return fromEnv;
  const built = builtExecutableHere();
  if (built === undefined) throw new Error(`no packaged tree for ${process.platform}-${process.arch}`);
  return built;
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The app's own page, served by a host on loopback. */
export const APP_URL = /^http:\/\/127\.0\.0\.1:\d+\/$/;
export const DEVTOOLS_URL = /^devtools:\/\//;

/** The windows the app opened: a devtools window is Chromium's own, enumerated alongside them and able to come first. */
export function appWindows(app: ElectronApplication): Page[] {
  return app.windows().filter(w => !DEVTOOLS_URL.test(w.url()));
}

/** The window showing a page, picked by its URL and never by the order the windows were made in. */
export function windowAt(app: ElectronApplication, url: RegExp): Promise<Page> {
  return vi.waitFor(
    () => {
      const page = appWindows(app).find(w => url.test(w.url()));
      if (page === undefined) throw new Error(`no window at ${url}, saw ${JSON.stringify(app.windows().map(w => w.url()))}`);
      return page;
    },
    { timeout: 30_000, interval: 50 },
  );
}

/** A login shell at `file` that prints `path`, which is the PATH the app reads off the shell it is handed and so what
 * decides which agents it finds. Without one the app would read the shell of the computer running the suite. */
export function loginShell(file: string, path: string): string {
  return writeStub(file, `#!/bin/sh\nprintf %s ${JSON.stringify(path)}\n`);
}
