// SPDX-License-Identifier: AGPL-3.0-only
// The agent the composer on screen sends with, by workspace, so the panel
// beside it can list that agent's tool servers first. The composer writes it
// as its pick moves; nothing outlives the window.
import { useEffect } from "react";
import { create } from "zustand";

interface ComposerAgentState {
  byWorkspaceId: Record<string, string>;
  show: (workspaceId: string, agent: string) => void;
  /** Takes the agent away where it is still the one this composer showed, since another may have mounted since. */
  hide: (workspaceId: string, agent: string) => void;
}

export const useComposerAgentStore = create<ComposerAgentState>()(set => ({
  byWorkspaceId: {},
  show: (workspaceId, agent) => set(s => (s.byWorkspaceId[workspaceId] === agent ? s : { byWorkspaceId: { ...s.byWorkspaceId, [workspaceId]: agent } })),
  hide: (workspaceId, agent) =>
    set(s => {
      if (s.byWorkspaceId[workspaceId] !== agent) return s;
      const { [workspaceId]: _gone, ...rest } = s.byWorkspaceId;
      return { byWorkspaceId: rest };
    }),
}));

export function useShowComposerAgent(workspaceId: string, agent: string): void {
  useEffect(() => {
    const { show, hide } = useComposerAgentStore.getState();
    show(workspaceId, agent);
    return () => hide(workspaceId, agent);
  }, [workspaceId, agent]);
}

export const useComposerAgent = (workspaceId: string): string | undefined => useComposerAgentStore(s => s.byWorkspaceId[workspaceId]);
