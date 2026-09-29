// SPDX-License-Identifier: AGPL-3.0-only
// From a git.diff reply to what the copied diff components read: parsed
// file diffs keyed for the code view, a line stat, and the changed-files
// rows for the tree. A file the daemon listed with an empty patch (over its
// byte budget) still appears in the tree so the reader knows it changed.
import type { FileDiffMetadata } from "@pierre/diffs";
import type { GitDiffReply, GitDiffScope } from "@wsp/protocol";
import type { TurnDiffFileChange } from "../components/chat/adapt.js";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  getDiffLineStat,
  getRenderablePatch,
  resolveFileDiffPath,
  type DiffLineStat,
} from "../lib/diffRendering.js";

export const SCOPE_LABELS: Record<GitDiffScope, string> = {
  head: "Uncommitted",
  unstaged: "Working tree",
  staged: "Staged",
  branch: "Branch changes",
};

/** What each scope holds, as a sentence names it: "No uncommitted changes at /root/app." */
export const SCOPE_NOUNS: Record<GitDiffScope, string> = {
  head: "uncommitted changes",
  unstaged: "working tree changes",
  staged: "staged changes",
  branch: "branch changes",
};

export const SCOPES: readonly GitDiffScope[] = ["branch", "head", "unstaged", "staged"];

export interface DiffFile {
  readonly fileDiff: FileDiffMetadata;
  readonly filePath: string;
  readonly fileKey: string;
  readonly fileVersion: number;
  /** The id git gives the file's worktree contents, which a viewed mark is kept against; absent for a file that is gone. */
  readonly blob?: string;
  /** The daemon's patch for the file, whole, which is what says whether it can be edited here. */
  readonly patch: string;
}

export interface DiffModel {
  readonly files: readonly DiffFile[];
  readonly stat: DiffLineStat;
  readonly changedFiles: readonly TurnDiffFileChange[];
  /** Set when the patch text could not be parsed into files. */
  readonly raw: { readonly text: string; readonly reason: string } | null;
}

/** Whether a file can be edited inside the pane: its new side is the file in the worktree, which the staged scope's
 * is not, it is not gone, and its patch is whole text git did not cut. */
export function editable(file: Pick<DiffFile, "fileDiff" | "patch">, scope: GitDiffScope): boolean {
  if (scope === "staged" || file.fileDiff.type === "deleted" || file.patch === "") return false;
  return !/^Binary files /m.test(file.patch) && !file.patch.includes("\nGIT binary patch");
}

function changeKind(fileDiff: FileDiffMetadata): string {
  switch (fileDiff.type) {
    case "new":
      return "added";
    case "deleted":
      return "deleted";
    case "rename-pure":
    case "rename-changed":
      return "renamed";
    default:
      return "modified";
  }
}

export function toDiffModel(reply: GitDiffReply, cacheScope: string): DiffModel {
  const patch = reply.files.map(f => f.patch).filter(p => p.length > 0).join("\n");
  const renderable = getRenderablePatch(patch, cacheScope);
  if (renderable?.kind === "raw") {
    return { files: [], stat: { additions: 0, deletions: 0 }, changedFiles: [], raw: renderable };
  }
  const sent = new Map(reply.files.map(f => [f.path, f]));
  const files: DiffFile[] = (renderable?.files ?? []).map(fileDiff => {
    const filePath = resolveFileDiffPath(fileDiff);
    const from = sent.get(filePath);
    return {
      fileDiff,
      filePath,
      fileKey: buildFileDiffIdentityKey(fileDiff),
      fileVersion: buildFileDiffContentVersion(fileDiff),
      patch: from?.patch ?? "",
      ...(from?.blob !== undefined ? { blob: from.blob } : {}),
    };
  });
  const parsedPaths = new Set(files.map(f => f.filePath));
  const changedFiles: TurnDiffFileChange[] = files.map(f => {
    const stat = getDiffLineStat([f.fileDiff]);
    return { path: f.filePath, kind: changeKind(f.fileDiff), additions: stat.additions, deletions: stat.deletions };
  });
  for (const f of reply.files) {
    if (!parsedPaths.has(f.path)) changedFiles.push({ path: f.path, kind: "modified", additions: 0, deletions: 0 });
  }
  return { files, stat: getDiffLineStat(files.map(f => f.fileDiff)), changedFiles, raw: null };
}
