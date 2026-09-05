// SPDX-License-Identifier: AGPL-3.0-only
// Paths as the daemon takes them: "." for its root (the workspace HOME unless
// it was started with --root), a root-relative path, or an absolute path
// inside the root. Every entry the panes hold is one of these, so a file can
// be read and a directory listed with the string as it is.
import type { FsListReply } from "@wsp/protocol";

export const ROOT = ".";

export interface ProjectEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
}

export function joinPath(dir: string, name: string): string {
  return dir === ROOT ? name : `${dir}/${name}`;
}

/** null at the daemon root or the filesystem root, where there is nowhere up to go. */
export function parentPath(path: string): string | null {
  if (path === ROOT || path === "/") return null;
  const cut = path.lastIndexOf("/");
  if (cut === -1) return ROOT;
  return cut === 0 ? "/" : path.slice(0, cut);
}

/** path below root as the tree shows it; the root itself is "". */
export function relativeTo(root: string, path: string): string {
  if (root === ROOT) return path;
  return path === root ? "" : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

export function displayPath(path: string): string {
  return path === ROOT ? "~" : path;
}

/** A symlink is listed as a file: fs.read follows it, fs.list never descends. */
export function toProjectEntries(reply: FsListReply, dir: string): ProjectEntry[] {
  return reply.entries.map(entry => ({ path: joinPath(dir, entry.name), kind: entry.type === "dir" ? "directory" : "file" }));
}

export function isMarkdownFile(path: string): boolean {
  return /\.(?:md|mdx)$/i.test(path);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
