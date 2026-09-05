// SPDX-License-Identifier: AGPL-3.0-only
// Where the files and diff panes are rooted, per workspace: the folder the
// thread's agent works in, as the composer picked it and the harness then
// reported it, unless the person pinned the panes somewhere. Not persisted:
// a reload follows the thread again.
import { create } from "zustand";
import { ROOT } from "./entries.js";

export interface WorkspaceRoot {
  /** The thread's working directory; null before any thread or pick. */
  readonly followed: string | null;
  /** Where the person parked the panes; null while they follow the thread. */
  readonly pinned: string | null;
}

interface RootStoreState {
  byWorkspaceId: Record<string, WorkspaceRoot>;
  follow: (workspaceId: string, cwd: string) => void;
  pin: (workspaceId: string, dir: string) => void;
  unpin: (workspaceId: string) => void;
}

const NONE: WorkspaceRoot = { followed: null, pinned: null };

export const useRootStore = create<RootStoreState>()(set => ({
  byWorkspaceId: {},
  follow: (workspaceId, cwd) =>
    set(s => {
      const current = s.byWorkspaceId[workspaceId] ?? NONE;
      return current.followed === cwd ? s : { byWorkspaceId: { ...s.byWorkspaceId, [workspaceId]: { ...current, followed: cwd } } };
    }),
  pin: (workspaceId, dir) =>
    set(s => ({ byWorkspaceId: { ...s.byWorkspaceId, [workspaceId]: { ...(s.byWorkspaceId[workspaceId] ?? NONE), pinned: dir } } })),
  unpin: workspaceId =>
    set(s => ({ byWorkspaceId: { ...s.byWorkspaceId, [workspaceId]: { ...(s.byWorkspaceId[workspaceId] ?? NONE), pinned: null } } })),
}));

export function selectRoot(byWorkspaceId: Record<string, WorkspaceRoot>, workspaceId: string): string {
  const entry = byWorkspaceId[workspaceId] ?? NONE;
  return entry.pinned ?? entry.followed ?? ROOT;
}

/** The folder the panes show right now. */
export function useRoot(workspaceId: string): string {
  return useRootStore(s => selectRoot(s.byWorkspaceId, workspaceId));
}

export function usePinned(workspaceId: string): boolean {
  return useRootStore(s => (s.byWorkspaceId[workspaceId] ?? NONE).pinned !== null);
}

/** The thread's own folder, pin or no pin: what the next session starts in. */
export function useFollowed(workspaceId: string): string | null {
  return useRootStore(s => (s.byWorkspaceId[workspaceId] ?? NONE).followed);
}
