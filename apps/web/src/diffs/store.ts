// SPDX-License-Identifier: AGPL-3.0-only
// What the diff surface remembers per workspace: the scope, or the one turn a
// reply's changed files opened it on. The folder git runs in is the panes'
// shared root (files/root.ts) for a scope and the turn's own folder for a turn.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { GitDiffScope } from "@wsp/protocol";

export type DiffRenderMode = "stacked" | "split";

/** The branch against its merge-base: the one scope that holds what a thread changed whether it committed or not.
 * A thread that commits as it goes leaves nothing uncommitted, and a pane first read there showed nothing. */
export const DEFAULT_SCOPE: GitDiffScope = "branch";

/** One turn's changes: the snapshots at its launch and its end, the folder they were taken in, and the file asked for. */
export interface TurnRange {
  readonly turnId: string;
  readonly cwd: string;
  readonly from: string;
  readonly to: string;
  readonly path?: string;
}

interface DiffStoreState {
  scopeByWorkspaceId: Record<string, GitDiffScope>;
  turnByWorkspaceId: Record<string, TurnRange>;
  renderMode: DiffRenderMode;
  setScope: (workspaceId: string, scope: GitDiffScope) => void;
  openTurn: (workspaceId: string, range: TurnRange) => void;
  setRenderMode: (mode: DiffRenderMode) => void;
}

export const useDiffStore = create<DiffStoreState>()(
  persist(
    set => ({
      scopeByWorkspaceId: {},
      turnByWorkspaceId: {},
      renderMode: "stacked",
      setScope: (workspaceId, scope) =>
        set(s => ({
          scopeByWorkspaceId: { ...s.scopeByWorkspaceId, [workspaceId]: scope },
          turnByWorkspaceId: Object.fromEntries(Object.entries(s.turnByWorkspaceId).filter(([id]) => id !== workspaceId)),
        })),
      openTurn: (workspaceId, range) => set(s => ({ turnByWorkspaceId: { ...s.turnByWorkspaceId, [workspaceId]: range } })),
      setRenderMode: renderMode => set({ renderMode }),
    }),
    {
      name: "wsp:diff-surface:v2",
      storage: createJSONStorage(() => window.localStorage),
      partialize: s => ({ scopeByWorkspaceId: s.scopeByWorkspaceId, renderMode: s.renderMode }),
    },
  ),
);
