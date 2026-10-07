// SPDX-License-Identifier: AGPL-3.0-only
// The desktop entry an AppImage launch writes for itself. Electron names this
// app the wsp:// handler on Linux by running xdg-settings on wsp.desktop, which
// fails with "file missing" unless an entry of that name sits in an
// applications folder; the AppImage carries one that nothing installs. So the
// launch writes it, naming the image file and the icon the kept copy holds,
// then makes the call. The same entry puts the app in the app grid.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The file name Electron hands xdg-settings, off package.json's desktopName. */
export const DESKTOP_FILE = "wsp.desktop";

export interface DesktopEntry {
  /** The AppImage file the person launched, which the entry runs. */
  image: string;
  /** The app's icon file, absolute; absent where the copy holds none. */
  icon?: string | undefined;
}

/** The spec's string escape, applied after an Exec word is quoted, so a backslash in a path reads as one. */
const escaped = (value: string): string => value.replace(/\\/g, "\\\\");

/** One Exec word, quoted as the spec asks only where it needs it: xdg-settings reads the first word raw, quotes and
 * all, and finds no program by a quoted name. `%` is doubled since it starts a field code. */
const execWord = (word: string): string => (/^[/0-9A-Za-z._-]+$/.test(word) ? word : escaped(`"${word.replace(/["`$\\]/g, c => `\\${c}`).replace(/%/g, "%%")}"`));

/** The entry, as electron-builder writes the one inside the AppImage: the image runs where AppRun ran. */
export function desktopEntryText(entry: DesktopEntry): string {
  return [
    "[Desktop Entry]",
    "Name=wsp",
    `Exec=${execWord(entry.image)} --no-sandbox %U`,
    "Terminal=false",
    "Type=Application",
    ...(entry.icon !== undefined ? [`Icon=${escaped(entry.icon)}`] : []),
    "StartupWMClass=wsp",
    "MimeType=x-scheme-handler/wsp;",
    "Categories=Development;",
    "",
  ].join("\n");
}

/** The applications folder xdg-settings and the app grid read for this login. */
export function applicationsDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const data = env["XDG_DATA_HOME"];
  return join(data !== undefined && data.startsWith("/") ? data : join(home, ".local", "share"), "applications");
}

/** The icon an AppImage's copy holds: its `.DirIcon`, a link to the largest of its icons, followed so the entry names
 * the PNG itself. */
export function appImageIcon(root: string): string | undefined {
  try {
    return realpathSync(join(root, ".DirIcon"));
  } catch {
    return undefined;
  }
}

/** Writes the entry unless one already says exactly this, so an image that moved is named again. Says which. */
export function installDesktopEntry(dir: string, text: string): "written" | "kept" {
  const path = join(dir, DESKTOP_FILE);
  if (existsSync(path) && readFileSync(path, "utf8") === text) return "kept";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o644 });
  return "written";
}

export interface LinkClaim {
  /** The entry an AppImage launch writes first; absent elsewhere, where the bundle or a package names the scheme. */
  entry?: DesktopEntry | undefined;
  dir: string;
  /** `app.setAsDefaultProtocolClient("wsp")`. */
  claim(): boolean;
  log(line: string): void;
}

/** Names this app the wsp:// handler, with the entry that call reads written before it. An entry that cannot be
 * written is said and the call still made, since a computer with an entry of its own may take it. */
export function claimWspLinks(c: LinkClaim): boolean {
  if (c.entry !== undefined) {
    try {
      c.log(`desktop entry ${installDesktopEntry(c.dir, desktopEntryText(c.entry))} at ${join(c.dir, DESKTOP_FILE)}`);
    } catch (e) {
      c.log(`desktop entry not written: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return c.claim();
}
