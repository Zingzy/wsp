// SPDX-License-Identifier: AGPL-3.0-only
// The side question standing in each workspace's right panel, in memory only:
// the question, then the host's answer or refusal. Closing it puts the panel
// back as it was, shut again if the question opened it, and an answer landing
// after the close, or after a newer question, lands nowhere.
import { create } from "zustand";
import { useRightPanelStore } from "../../rightPanelStore";

export interface Aside {
  readonly id: number;
  readonly question: string;
  readonly answer?: string;
  readonly error?: string;
  /** Whether the panel was open before the question, so closing it knows whether to shut the panel again. */
  readonly panelWasOpen: boolean;
}

interface AsideState {
  byWorkspace: Record<string, Aside>;
  /** Stands a question in the workspace's panel and answers with the id its answer must carry. */
  ask(workspaceId: string, question: string, panelWasOpen: boolean): number;
  answer(workspaceId: string, id: number, reply: { answer: string } | { error: string }): void;
  close(workspaceId: string): void;
}

let asked = 0;

export const useAsideStore = create<AsideState>()((set, get) => ({
  byWorkspace: {},
  ask(workspaceId, question, panelWasOpen) {
    const id = ++asked;
    // A question asked over one still standing keeps the panel's state from before the first.
    const before = get().byWorkspace[workspaceId]?.panelWasOpen ?? panelWasOpen;
    set(s => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: { id, question, panelWasOpen: before } } }));
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
    if (!standing.panelWasOpen) useRightPanelStore.getState().close(workspaceId);
  },
}));

export function useAside(workspaceId: string): Aside | null {
  return useAsideStore(s => s.byWorkspace[workspaceId] ?? null);
}
