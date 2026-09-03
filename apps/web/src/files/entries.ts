// SPDX-License-Identifier: AGPL-3.0-only
// What the copied tree and breadcrumbs read: the daemon's fs.list rows
// flattened to workspace-relative paths with a file-or-directory kind. Paths
// are relative to the daemon root, which is the workspace HOME unless the
// daemon was started with --root, so "" names that root everywhere here.
import type { FsListReply } from "@wsp/protocol";

export interface ProjectEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
}

/** The daemon lists breadth-first to this depth; deeper trees show truncated. */
export const LIST_DEPTH = 8;

/** A symlink is listed as a file: fs.read follows it, fs.list never descends. */
export function toProjectEntries(reply: FsListReply): ProjectEntry[] {
  return reply.entries.map(entry => ({ path: entry.name, kind: entry.type === "dir" ? "directory" : "file" }));
}

export function isMarkdownFile(path: string): boolean {
  return /\.(?:md|mdx)$/i.test(path);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
