// SPDX-License-Identifier: AGPL-3.0-only
// Where the files and diff panes are rooted, per workspace: the folder the
// thread's agent works in, as the composer picked it, the harness then
// reported it, and the agent's own tool calls then moved its shell, unless
// the person pinned the panes somewhere; before any, the daemon's own root.
// Every path here is absolute. Not persisted: a reload follows the thread
// again.
import { create } from "zustand";
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
 * folder, else the daemon root (null until its hello). */
export function selectRoot(byWorkspaceId: Record<string, WorkspaceRoot>, workspaceId: string, daemonRoot: string | null): string | null {
  const entry = byWorkspaceId[workspaceId] ?? NONE;
  const shell = entry.shell !== null && daemonRoot !== null && within(entry.shell, daemonRoot) ? entry.shell : null;
  return entry.pinned ?? shell ?? entry.followed ?? daemonRoot;
}

export function useRoot(workspaceId: string): string | null {
  const daemonRoot = useDaemonRoot(workspaceId);
  return useRootStore(s => selectRoot(s.byWorkspaceId, workspaceId, daemonRoot));
}

export function usePinned(workspaceId: string): boolean {
  return useRootStore(s => (s.byWorkspaceId[workspaceId] ?? NONE).pinned !== null);
}

/** The folder the next session starts in, pin or no pin: the thread's own, else the daemon root, else nothing known. */
export function useThreadFolder(workspaceId: string): string | null {
  const daemonRoot = useDaemonRoot(workspaceId);
  return useRootStore(s => (s.byWorkspaceId[workspaceId] ?? NONE).followed ?? daemonRoot);
}
