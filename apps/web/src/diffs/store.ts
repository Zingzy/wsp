// SPDX-License-Identifier: AGPL-3.0-only
// What the diff surface remembers per workspace: the scope and the folder
// git runs in. The daemon root is the workspace HOME, which is rarely a repo
// itself, so the folder is a choice the reader makes once and keeps.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { GitDiffScope } from "@wsp/protocol";
import { ROOT } from "../files/listing.js";

export type DiffRenderMode = "stacked" | "split";

export interface DiffSelection {
  readonly scope: GitDiffScope;
  readonly cwd: string;
}

export const DEFAULT_SELECTION: DiffSelection = { scope: "unstaged", cwd: ROOT };

interface DiffStoreState {
  byWorkspaceId: Record<string, DiffSelection>;
  renderMode: DiffRenderMode;
  setScope: (workspaceId: string, scope: GitDiffScope) => void;
  setCwd: (workspaceId: string, cwd: string) => void;
  setRenderMode: (mode: DiffRenderMode) => void;
}

export const useDiffStore = create<DiffStoreState>()(
  persist(
    set => ({
      byWorkspaceId: {},
      renderMode: "stacked",
      setScope: (workspaceId, scope) =>
        set(s => ({ byWorkspaceId: { ...s.byWorkspaceId, [workspaceId]: { ...(s.byWorkspaceId[workspaceId] ?? DEFAULT_SELECTION), scope } } })),
      setCwd: (workspaceId, cwd) =>
        set(s => ({ byWorkspaceId: { ...s.byWorkspaceId, [workspaceId]: { ...(s.byWorkspaceId[workspaceId] ?? DEFAULT_SELECTION), cwd } } })),
      setRenderMode: renderMode => set({ renderMode }),
    }),
    {
      name: "wsp:diff-surface:v1",
      storage: createJSONStorage(() => window.localStorage),
      partialize: s => ({ byWorkspaceId: s.byWorkspaceId, renderMode: s.renderMode }),
    },
  ),
);

export function selectDiffSelection(byWorkspaceId: Record<string, DiffSelection>, workspaceId: string): DiffSelection {
  return byWorkspaceId[workspaceId] ?? DEFAULT_SELECTION;
}
