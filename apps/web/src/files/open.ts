// SPDX-License-Identifier: AGPL-3.0-only
// A file a reply or a terminal line names, opened as its own tab in the Files
// pane at the line it names. A relative path is read against the folder the
// thread or the shell works in, since that is the folder it was written from.
import { useRightPanelStore } from "../rightPanelStore.js";
import { resolvePathLinkTarget, splitPathAndPosition } from "../terminal-links.js";
import { threadFolderOf } from "./root.js";

/** An absolute path with its `.` and `..` segments walked, so one file is one tab however it was written. */
function walked(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** Opens `named`, which may carry its own `:line`, against `cwd`; a line given beside it wins. */
export function openNamedFile(workspaceId: string, named: string, cwd: string, line?: number): void {
  const { path, line: written } = splitPathAndPosition(resolvePathLinkTarget(named, cwd));
  const at = line ?? (written === undefined ? undefined : Number(written));
  useRightPanelStore.getState().openFile(workspaceId, walked(path), at);
}

/** A path clicked in a terminal: read against the folder the workspace's shells open in. */
export function openTerminalPath(workspaceId: string, text: string): void {
  const cwd = threadFolderOf(workspaceId);
  if (cwd !== null) openNamedFile(workspaceId, text, cwd);
}
