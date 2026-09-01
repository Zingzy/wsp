// SPDX-License-Identifier: AGPL-3.0-only
// Zustand store fed by one ProtocolClient + typed React hooks. The six component
// tickets code against these hooks; they are the stable contract.
import { useEffect } from "react";
import { create } from "zustand";
import type { SessionView, WorkspaceView } from "@wsp/protocol";
import type { Api, ProtocolEvent } from "./client.js";

interface State {
  api: Api | null;
  workspaces: WorkspaceView[];
  selectedId: string | null;
  sessions: Record<string, SessionView[]>;
  ready: boolean;
  bind(api: Api): void;
  select(id: string | null): void;
  refresh(): Promise<void>;
  applyEvent(e: ProtocolEvent): void;
}

export const useStore = create<State>((set, get) => ({
  api: null,
  workspaces: [],
  selectedId: null,
  sessions: {},
  ready: false,
  bind(api) {
    set({ api });
    api.subscribe(e => get().applyEvent(e));
    void get().refresh();
  },
  select(id) { set({ selectedId: id }); },
  async refresh() {
    const api = get().api;
    if (!api) return;
    const workspaces = await api.listWorkspaces();
    set(s => ({ workspaces, ready: true, selectedId: s.selectedId ?? workspaces[0]?.id ?? null }));
  },
  applyEvent(e) {
    // Deleted carries only an id; the other lifecycle events carry a fresh view.
    if (e.type === "workspace.deleted") {
      const id = (e as { workspaceId?: string; id?: string }).workspaceId ?? (e as { id?: string }).id;
      if (id) set(s => ({ workspaces: s.workspaces.filter(x => x.id !== id) }));
      return;
    }
    if (e.type.startsWith("workspace.") && "workspace" in e && e.workspace) {
      const w = e.workspace as WorkspaceView;
      set(s => {
        const rest = s.workspaces.filter(x => x.id !== w.id);
        return { workspaces: [...rest, w].sort((a, b) => a.id.localeCompare(b.id)) };
      });
    }
  },
}));

export function useWorkspaces(): WorkspaceView[] { return useStore(s => s.workspaces); }
export function useSelectedId(): string | null { return useStore(s => s.selectedId); }
export function useWorkspace(id: string | null): WorkspaceView | null {
  return useStore(s => (id ? s.workspaces.find(w => w.id === id) ?? null : null));
}
export function useSession(workspaceId: string | null): SessionView[] {
  return useStore(s => (workspaceId ? s.sessions[workspaceId] ?? [] : []));
}
export function useReady(): boolean { return useStore(s => s.ready); }

/** Subscribe a component to raw protocol events (terminal/chat/browser tabs use this). */
export function useProtocolEvents(fn: (e: ProtocolEvent) => void): void {
  const api = useStore(s => s.api);
  useEffect(() => (api ? api.subscribe(fn) : undefined), [api, fn]);
}
