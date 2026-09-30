// SPDX-License-Identifier: AGPL-3.0-only
// Open in editor on the computer the host runs on: a fixed table of editors,
// each found by its app bundle and run with its own program and the path as
// one argument, never through a shell and never a program a client names.
// The path has to resolve inside one of the folders the caller hands over,
// lexically and then through its links, so a path from a page opens nothing
// else on this computer.
import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, posix, resolve } from "node:path";
import { editorOpensHereLine, type EditorChoice, type EditorId } from "@wsp/protocol";
import type { HostEditor } from "@wsp/runtime";
import { under } from "./init-import.js";

/** A program and its arguments, as spawn takes them. */
export interface EditorCommand {
  readonly file: string;
  readonly args: readonly string[];
}

interface EditorRow {
  readonly id: EditorId;
  readonly name: string;
  /** The app bundles it installs as; the first one found is the one run. */
  readonly apps: readonly string[];
  command(app: string, path: string, line: number | undefined, folder: boolean): EditorCommand;
  /** The same over ssh into a workspace on another computer: the workspace's folder, and the file at its line where
   * one was asked for. Absent on an editor with no remote road of its own. */
  remote?(app: string, alias: string, folder: string, file: string | undefined, line: number | undefined): EditorCommand;
}

const OPEN = "/usr/bin/open";

/** VS Code and the editors built on it take `-g path:line` for a line. */
const vscodeRow = (id: EditorId, name: string, app: string, bin: string): EditorRow => ({
  id,
  name,
  apps: [app],
  command: (found, path, line) => ({ file: join(found, "Contents/Resources/app/bin", bin), args: line === undefined ? [path] : ["-g", `${path}:${line}`] }),
  remote: (found, alias, folder, file, line) => ({
    file: join(found, "Contents/Resources/app/bin", bin),
    args: ["--remote", `ssh-remote+${alias}`, folder, ...(file === undefined ? [] : ["--goto", line === undefined ? file : `${file}:${line}`])],
  }),
});

/** A JetBrains IDE through the Mac's own opener, which hands the arguments to the running instance, `--line` included. */
const jetbrainsRow = (id: EditorId, name: string, apps: readonly string[]): EditorRow => ({
  id,
  name,
  apps,
  command: (found, path, line) => ({ file: OPEN, args: ["-na", found, "--args", ...(line === undefined ? [] : ["--line", String(line)]), path] }),
});

/** In the order the picker lists them. */
export const EDITORS: readonly EditorRow[] = [
  vscodeRow("vscode", "VS Code", "Visual Studio Code.app", "code"),
  vscodeRow("cursor", "Cursor", "Cursor.app", "cursor"),
  vscodeRow("vscode-insiders", "VS Code Insiders", "Visual Studio Code - Insiders.app", "code"),
  {
    id: "zed",
    name: "Zed",
    apps: ["Zed.app"],
    command: (found, path, line) => ({ file: join(found, "Contents/MacOS/cli"), args: [line === undefined ? path : `${path}:${line}`] }),
    // The folder first: the file alone opens as a worktree of one file, which Zed asks to be trusted apart.
    remote: (found, alias, folder, file, line) => ({
      file: join(found, "Contents/MacOS/cli"),
      args: [`ssh://${alias}${folder}`, ...(file === undefined ? [] : [`ssh://${alias}${file}${line === undefined ? "" : `:${line}`}`])],
    }),
  },
  jetbrainsRow("idea", "IntelliJ IDEA", ["IntelliJ IDEA.app", "IntelliJ IDEA Ultimate.app", "IntelliJ IDEA CE.app", "IntelliJ IDEA Community Edition.app"]),
  jetbrainsRow("webstorm", "WebStorm", ["WebStorm.app"]),
  jetbrainsRow("pycharm", "PyCharm", ["PyCharm.app", "PyCharm Professional Edition.app", "PyCharm CE.app", "PyCharm Community Edition.app"]),
  jetbrainsRow("goland", "GoLand", ["GoLand.app"]),
  jetbrainsRow("rustrover", "RustRover", ["RustRover.app"]),
  jetbrainsRow("clion", "CLion", ["CLion.app"]),
  jetbrainsRow("phpstorm", "PhpStorm", ["PhpStorm.app"]),
  jetbrainsRow("rubymine", "RubyMine", ["RubyMine.app"]),
  jetbrainsRow("rider", "Rider", ["Rider.app"]),
  {
    id: "finder",
    name: "Finder",
    apps: ["/System/Library/CoreServices/Finder.app"],
    // A file is revealed in its folder, since opening it would hand it to whatever app owns its type.
    command: (_found, path, _line, folder) => ({ file: OPEN, args: folder ? [path] : ["-R", path] }),
  },
];

export const NO_EDITOR_LINE = "No editor wsp knows is installed on this computer.";
export const editorMissingLine = (name: string): string => `${name} is not installed on this computer; pick another editor in Settings.`;
export const editorOutsideLine = (path: string): string => `${path} is not in this workspace's folder, so it does not open in your editor.`;

export interface EditorHostOptions {
  /** What this computer runs; the table is the Mac's, and anything else has no editor in it. */
  platform?: NodeJS.Platform;
  home?: string;
  /** Whether a path exists; the disk's own answer unless a test gives one. */
  exists?: (path: string) => boolean;
  /** Starts the program and resolves once it started; spawn with no shell unless a test gives one. */
  run?: (command: EditorCommand) => Promise<void>;
}

function onDisk(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function realOf(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Starts the program with its arguments as they are: no shell reads them, and the host does not wait for it to end. */
export function startProgram(command: EditorCommand): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(command.file, [...command.args], { shell: false, detached: true, stdio: "ignore" });
    child.once("error", fail);
    child.once("spawn", () => {
      child.unref();
      done();
    });
  });
}

/** The path as it may be opened: absolute, inside one of the folders by its words, and inside one of them still once
 * every link on the way is followed. Refused otherwise, before anything runs. */
export function openablePath(path: string, inside: readonly string[]): string {
  if (!isAbsolute(path)) throw new Error(editorOutsideLine(path));
  const asked = resolve(path);
  const folders = inside.map(folder => resolve(folder));
  if (!folders.some(folder => under(asked, folder))) throw new Error(editorOutsideLine(path));
  const real = realOf(asked);
  const realFolders = folders.flatMap(folder => realOf(folder) ?? []);
  if (real === null || !realFolders.some(folder => under(real, folder))) throw new Error(editorOutsideLine(path));
  return asked;
}

/** A path inside a workspace's folder on another computer, by its words: absolute, and under that folder once every
 * way up is taken. */
function remotePath(path: string, folder: string): string {
  if (!posix.isAbsolute(path)) throw new Error(editorOutsideLine(path));
  const asked = posix.resolve(path);
  const root = posix.resolve(folder);
  if (asked !== root && !asked.startsWith(`${root}/`)) throw new Error(editorOutsideLine(path));
  return asked;
}

export function editorHost(o: EditorHostOptions = {}): HostEditor {
  const platform = o.platform ?? process.platform;
  const home = o.home ?? homedir();
  const exists = o.exists ?? onDisk;
  const run = o.run ?? startProgram;
  const foundApp = (row: EditorRow): string | undefined => {
    for (const app of row.apps) {
      const places = isAbsolute(app) ? [app] : [join("/Applications", app), join(home, "Applications", app)];
      const found = places.find(exists);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const installed = (): { row: EditorRow; app: string }[] =>
    platform !== "darwin" ? [] : EDITORS.flatMap(row => {
      const app = foundApp(row);
      return app === undefined ? [] : [{ row, app }];
    });
  return {
    list: async (): Promise<EditorChoice[]> => installed().map(({ row }) => ({ id: row.id, name: row.name, ...(row.remote !== undefined ? { remote: true as const } : {}) })),
    open: async ({ path, line, inside, editor, remote }) => {
      // A workspace on another computer holds its files there, so its path is held to the folder by its words alone.
      const opening = remote === undefined ? openablePath(path, inside) : remotePath(path, remote.folder);
      const here = installed();
      const pick = editor === undefined ? here[0] : here.find(({ row }) => row.id === editor);
      if (pick === undefined) {
        const named = EDITORS.find(row => row.id === editor);
        throw new Error(named === undefined ? NO_EDITOR_LINE : editorMissingLine(named.name));
      }
      if (remote !== undefined) {
        if (pick.row.remote === undefined) throw new Error(editorOpensHereLine(remote.name));
        const folder = posix.resolve(remote.folder);
        await run(pick.row.remote(pick.app, remote.alias, folder, opening === folder ? undefined : opening, line));
        return pick.row.id;
      }
      const folder = statSync(opening).isDirectory();
      await run(pick.row.command(pick.app, opening, folder ? undefined : line, folder));
      return pick.row.id;
    },
  };
}
