// SPDX-License-Identifier: AGPL-3.0-only
// Where the files and diff panes are rooted, per workspace: the folder the
// thread's agent works in, as the composer picked it, the harness then
// reported it, and the agent's own tool calls then moved its shell, unless
// the person pinned the panes somewhere; before any, the daemon's home. The
// roots the daemon browses are its home and the imported project folder on
// the workspace record; both panes read that one list. Every path here is
// absolute. Not persisted: a reload follows the thread again.
import { useMemo } from "react";
import { create } from "zustand";
import { useStore } from "../protocol/store.js";
import { parentPath } from "./entries.js";
import { useDaemonRoot } from "./wire.js";

export interface WorkspaceRoot {
  /** The thread's working directory, where its harness runs and the next turn resumes; null before any thread or pick. */
  readonly followed: string | null;
  /** Where the agent's tool shell is, as its tool calls moved it; null until one did. */
  readonly shell: string | null;
  /** Where the person parked the panes; null while they follow the thread. */
  readonly pinned: string | null;
}

interface RootStoreState {
  byWorkspaceId: Record<string, WorkspaceRoot>;
  follow: (workspaceId: string, cwd: string) => void;
  shell: (workspaceId: string, dir: string | null) => void;
  pin: (workspaceId: string, dir: string) => void;
  unpin: (workspaceId: string) => void;
}

const NONE: WorkspaceRoot = { followed: null, shell: null, pinned: null };

function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder === "/" ? "/" : `${folder}/`);
}

/** The browsable roots, home first: the daemon's home and the imported project folder when the record has one. Empty
 * until the daemon's hello. */
export function rootsOf(home: string | null, projectDest: string | undefined): string[] {
  if (home === null) return [];
  return projectDest === undefined || projectDest === home ? [home] : [home, projectDest];
}

/** The root a path sits in, the nearest when roots nest; null when it is outside every root. */
export function rootOf(roots: readonly string[], path: string): string | null {
  let found: string | null = null;
  for (const root of roots) if (within(path, root) && (found === null || root.length > found.length)) found = root;
  return found;
}

/** The folder above, while a root still holds it: null at a root's edge, which is where the daemon refuses to list. */
export function parentWithin(roots: readonly string[], path: string): string | null {
  const above = parentPath(path);
  return above !== null && rootOf(roots, above) !== null ? above : null;
}

export const useRootStore = create<RootStoreState>()(set => ({
  byWorkspaceId: {},
  follow: (workspaceId, cwd) =>
    set(s => {
      const current = s.byWorkspaceId[workspaceId] ?? NONE;
      return current.followed === cwd ? s : { byWorkspaceId: { ...s.byWorkspaceId, [workspaceId]: { ...current, followed: cwd } } };
    }),
  shell: (workspaceId, dir) =>
    set(s => {
      const current = s.byWorkspaceId[workspaceId] ?? NONE;
      return current.shell === dir ? s : { byWorkspaceId: { ...s.byWorkspaceId, [workspaceId]: { ...current, shell: dir } } };
    }),
  pin: (workspaceId, dir) =>
    set(s => ({ byWorkspaceId: { ...s.byWorkspaceId, [workspaceId]: { ...(s.byWorkspaceId[workspaceId] ?? NONE), pinned: dir } } })),
  unpin: workspaceId =>
    set(s => ({ byWorkspaceId: { ...s.byWorkspaceId, [workspaceId]: { ...(s.byWorkspaceId[workspaceId] ?? NONE), pinned: null } } })),
}));

/** The folder the panes show: the pin, else the agent's shell folder where the daemon can list it, else the thread's
 * folder, else the daemon's home (null until its hello). */
export function selectRoot(byWorkspaceId: Record<string, WorkspaceRoot>, workspaceId: string, roots: readonly string[]): string | null {
  const entry = byWorkspaceId[workspaceId] ?? NONE;
  const shell = entry.shell !== null && rootOf(roots, entry.shell) !== null ? entry.shell : null;
  return entry.pinned ?? shell ?? entry.followed ?? roots[0] ?? null;
}

export function useRoots(workspaceId: string): string[] {
  const home = useDaemonRoot(workspaceId);
  const projectDest = useStore(s => s.workspaces.find(w => w.id === workspaceId)?.project?.dest);
  return useMemo(() => rootsOf(home, projectDest), [home, projectDest]);
}

export function useRoot(workspaceId: string): string | null {
  const roots = useRoots(workspaceId);
  return useRootStore(s => selectRoot(s.byWorkspaceId, workspaceId, roots));
}

export function usePinned(workspaceId: string): boolean {
  return useRootStore(s => (s.byWorkspaceId[workspaceId] ?? NONE).pinned !== null);
}

/** The folder the next session starts in, pin or no pin: the thread's own, else the imported project's, else the
 * daemon root, else nothing known. A thread's folder decides which project state its agent loads, so a workspace with
 * a project opens its threads there; wsp's own verbs read the same order (workFolder). */
export function useThreadFolder(workspaceId: string): string | null {
  const daemonRoot = useDaemonRoot(workspaceId);
  const projectDest = useStore(s => s.workspaces.find(w => w.id === workspaceId)?.project?.dest);
  return useRootStore(s => (s.byWorkspaceId[workspaceId] ?? NONE).followed ?? projectDest ?? daemonRoot);
}
