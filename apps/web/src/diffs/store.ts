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

/** One turn's changes: the snapshots at its launch and its end, the folder they were taken in, and the file asked for.
 * only narrows the range to the files of one list on the turn's card, in a folder other threads worked in too. */
export interface TurnRange {
  readonly turnId: string;
  readonly cwd: string;
  readonly from: string;
  readonly to: string;
  readonly path?: string;
  readonly only?: ReadonlyArray<string>;
}

/** The files a turn's range opens narrowed to, where the turn's own files are known: the others' when the row asked
 * for is theirs or the turn has none of its own, else its own. Undefined leaves the range whole. */
export function onlyOf(changes: { readonly files: ReadonlyArray<{ readonly path: string }>; readonly others?: ReadonlyArray<{ readonly path: string }> }, path?: string): string[] | undefined {
  const { files, others } = changes;
  if (others === undefined) return undefined;
  return (others.some(f => f.path === path) || files.length === 0 ? others : files).map(f => f.path);
}

/** The path a turn's changes name a file by, from the top of the checkout, for a path an edit named whole; undefined
 * where the turn recorded no change to it. */
export function changedPathOf(changes: { readonly files: ReadonlyArray<{ readonly path: string }>; readonly others?: ReadonlyArray<{ readonly path: string }> }, named: string): string | undefined {
  return [...changes.files, ...(changes.others ?? [])].find(f => f.path === named || named.endsWith(`/${f.path}`))?.path;
}

/** The same turn's range with nothing narrowed. */
export function wholeRange(range: TurnRange): TurnRange {
  const { only: _narrowed, ...whole } = range;
  return whole;
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
      // The turn a reply opened is kept too, so a reload shows that turn and not the branch against its base.
      partialize: s => ({ scopeByWorkspaceId: s.scopeByWorkspaceId, turnByWorkspaceId: s.turnByWorkspaceId, renderMode: s.renderMode }),
    },
  ),
);
