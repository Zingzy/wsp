// SPDX-License-Identifier: AGPL-3.0-only
// The branch on row three of a workspace's tiles. A copy's is on the record it
// was made with. A workspace with no copy record, a fork among them, has its
// branch read off git.status in its project's folder over the workspace's own
// daemon link, once per workspace however many tiles it has, asked again each
// time that link comes up; the last answer stands while the link is down.
import { useEffect } from "react";
import type { SidebarProjectSnapshot } from "../adapt/index.js";
import { useDaemonWire } from "../files/wire.js";
import { useBranch, useLinkWord } from "../terminal/paneWords.js";
import { branchLine } from "./workspaceRows.js";

type Workspace = Pick<SidebarProjectSnapshot, "id" | "workspace">;

/** Whether a workspace's branch is read off its daemon rather than off its record. */
export const readsBranch = (project: Workspace): boolean => project.workspace.copy === undefined;

/** The branch a workspace's tiles show: the record's for a copy, the one read off its daemon otherwise, and empty
 * until one is known or where git names none. */
export const workspaceBranch = (project: Workspace, read: Readonly<Record<string, string>>): string => (readsBranch(project) ? (read[project.id] ?? "") : branchLine(project));

/** One workspace's branch read off its daemon and handed up by its id; draws nothing. */
export function BranchReader({ project, onBranch }: { project: Workspace; onBranch: (workspaceId: string, branch: string) => void }) {
  const link = useLinkWord(project.id);
  const read = useBranch(useDaemonWire(project.id), project.workspace.project.path, link === "live", link);
  const branch = read.kind === "repo" ? read.head : "";
  useEffect(() => onBranch(project.id, branch), [onBranch, project.id, branch]);
  return null;
}
