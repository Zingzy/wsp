// SPDX-License-Identifier: AGPL-3.0-only
// The side question standing in each workspace's right panel, in memory only:
// the question, then the host's answer or refusal, on a tab of its own beside
// the panel's others. Closing it takes the tab away and puts the panel back as
// it was, shut again if the question opened it, and an answer landing after the
// close, or after a newer question, lands nowhere.
import { create } from "zustand";
import { selectWorkspaceRightPanelState, useRightPanelStore } from "../../rightPanelStore";

export interface Aside {
  readonly id: number;
  readonly question: string;
  readonly answer?: string;
  readonly error?: string;
  /** Whether the panel was open before the question, so closing it knows whether to shut the panel again. */
  readonly panelWasOpen: boolean;
  /** The tab that showed before the question, which closing it shows again while that tab still stands. */
  readonly activeBefore: string | null;
}

interface AsideState {
  byWorkspace: Record<string, Aside>;
  /** Stands a question on its tab in the workspace's panel and answers with the id its answer must carry. */
  ask(workspaceId: string, question: string): number;
  answer(workspaceId: string, id: number, reply: { answer: string } | { error: string }): void;
  close(workspaceId: string): void;
}

let asked = 0;

export const useAsideStore = create<AsideState>()((set, get) => ({
  byWorkspace: {},
  ask(workspaceId, question) {
    const id = ++asked;
    const panel = useRightPanelStore.getState();
    // A question asked over one still standing keeps the panel's state from before the first.
    const was = selectWorkspaceRightPanelState(panel.byWorkspaceId, workspaceId);
    const standing = get().byWorkspace[workspaceId];
    const before = standing === undefined ? { panelWasOpen: was.isOpen, activeBefore: was.activeSurfaceId } : { panelWasOpen: standing.panelWasOpen, activeBefore: standing.activeBefore };
    set(s => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: { id, question, ...before } } }));
    panel.open(workspaceId, "aside");
    return id;
  },
  answer(workspaceId, id, reply) {
    set(s => {
      const standing = s.byWorkspace[workspaceId];
      if (standing?.id !== id) return s;
      return { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...standing, ...reply } } };
    });
  },
  close(workspaceId) {
    const standing = get().byWorkspace[workspaceId];
    if (standing === undefined) return;
    set(s => {
      const { [workspaceId]: _gone, ...rest } = s.byWorkspace;
      return { byWorkspace: rest };
    });
    const panel = useRightPanelStore.getState();
    panel.closeSurface(workspaceId, "aside");
    if (standing.activeBefore !== null) panel.activateSurface(workspaceId, standing.activeBefore);
    if (!standing.panelWasOpen) panel.close(workspaceId);
  },
}));

export function useAside(workspaceId: string): Aside | null {
  return useAsideStore(s => s.byWorkspace[workspaceId] ?? null);
}
