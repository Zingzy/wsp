// SPDX-License-Identifier: AGPL-3.0-only
// Zustand store fed by one ProtocolClient + typed React hooks. The six component
// tickets code against these hooks; they are the stable contract.
import { useEffect } from "react";
import { create } from "zustand";
import type { SessionView, WorkspacePhase, WorkspaceStatus, WorkspaceView } from "@wsp/protocol";
import type { Api, ProtocolEvent } from "./client.js";

export interface CostTick {
  rateUsdPerHour: number;
  accruedUsd: number;
  at: string;
}

interface State {
  api: Api | null;
  workspaces: WorkspaceView[];
  statuses: Record<string, WorkspaceStatus>;
  costs: Record<string, CostTick>;
  /** Live session count per workspace; > 0 renders the spend-pulse. */
  spending: Record<string, number>;
  toast: string | null;
  selectedId: string | null;
  sessions: Record<string, SessionView[]>;
  ready: boolean;
  bind(api: Api): void;
  select(id: string | null): void;
  refresh(): Promise<void>;
  /** Optimistic nap/wake: paint now, reconcile on the event, revert + toast on failure. */
  toggle(id: string): Promise<void>;
  createWorkspace(name: string): Promise<void>;
  clearToast(): void;
  applyEvent(e: ProtocolEvent): void;
}

export const useStore = create<State>((set, get) => {
  // wake-via-resurrect and upgrade replace the machine, so those events carry a new machineId
  const setPhase = (id: string, phase: WorkspacePhase, machineId?: string): void => {
    const patch = { phase, ...(machineId !== undefined ? { machineId } : {}) };
    set(s => ({
      workspaces: s.workspaces.map(w => (w.id === id ? { ...w, ...patch } : w)),
      statuses: s.statuses[id] ? { ...s.statuses, [id]: { ...s.statuses[id]!, ...patch } } : s.statuses,
    }));
  };

  return {
    api: null,
    workspaces: [],
    statuses: {},
    costs: {},
    spending: {},
    toast: null,
    selectedId: null,
    sessions: {},
    ready: false,
    bind(api) {
      set({ api });
      api.subscribe(e => get().applyEvent(e));
      void get().refresh();
      void api
        .watchStatuses()
        .then(statuses => set({ statuses: Object.fromEntries(statuses.map(s => [s.id, s])) }))
        .catch((e: unknown) => set({ toast: `live status unavailable: ${e instanceof Error ? e.message : String(e)}` }));
    },
    select(id) { set({ selectedId: id }); },
    async refresh() {
      const api = get().api;
      if (!api) return;
      const workspaces = await api.listWorkspaces();
      set(s => ({ workspaces, ready: true, selectedId: s.selectedId ?? workspaces[0]?.id ?? null }));
    },
    async toggle(id) {
      const api = get().api;
      const w = get().workspaces.find(x => x.id === id);
      if (!api || !w) return;
      const to: WorkspacePhase = w.phase === "running" ? "napping" : "running";
      setPhase(id, to);
      try {
        await (to === "napping" ? api.nap(id) : api.wake(id));
      } catch (e) {
        setPhase(id, w.phase);
        set({ toast: `${w.name}: ${e instanceof Error ? e.message : String(e)}` });
      }
    },
    async createWorkspace(name) {
      const api = get().api;
      if (!api) return;
      try {
        await api.createFromGoldenHead(name); // workspace.created carries the view back
      } catch (e) {
        set({ toast: e instanceof Error ? e.message : String(e) });
      }
    },
    clearToast() { set({ toast: null }); },
    applyEvent(e) {
      switch (e.type) {
        case "workspace.deleted":
          set(s => {
            const { [e.workspaceId]: _s, ...statuses } = s.statuses;
            const { [e.workspaceId]: _c, ...costs } = s.costs;
            const { [e.workspaceId]: _p, ...spending } = s.spending;
            return { workspaces: s.workspaces.filter(x => x.id !== e.workspaceId), statuses, costs, spending };
          });
          return;
        case "workspace.created":
          set(s => {
            const rest = s.workspaces.filter(x => x.id !== e.workspace.id);
            return { workspaces: [...rest, e.workspace].sort((a, b) => a.id.localeCompare(b.id)) };
          });
          return;
        // napped/woken carry only ids; they are also the optimistic toggle's reconcile.
        case "workspace.napped":
          setPhase(e.workspaceId, "napping");
          return;
        case "workspace.woken":
        case "workspace.upgraded":
          setPhase(e.workspaceId, "running", e.machineId);
          return;
        case "workspace.status":
          set(s => ({ statuses: { ...s.statuses, [e.status.id]: e.status } }));
          return;
        case "workspace.cost":
          set(s => ({
            costs: { ...s.costs, [e.workspaceId]: { rateUsdPerHour: e.rateUsdPerHour, accruedUsd: e.accruedUsd, at: e.at } },
          }));
          return;
        case "session.start":
          set(s => ({ spending: { ...s.spending, [e.workspaceId]: (s.spending[e.workspaceId] ?? 0) + 1 } }));
          return;
        case "session.end":
          set(s => ({ spending: { ...s.spending, [e.workspaceId]: Math.max(0, (s.spending[e.workspaceId] ?? 0) - 1) } }));
          return;
        default:
          return;
      }
    },
  };
});

export function useWorkspaces(): WorkspaceView[] { return useStore(s => s.workspaces); }
export function useSelectedId(): string | null { return useStore(s => s.selectedId); }
export function useWorkspace(id: string | null): WorkspaceView | null {
  return useStore(s => (id ? s.workspaces.find(w => w.id === id) ?? null : null));
}
export function useStatus(id: string | null): WorkspaceStatus | null {
  return useStore(s => (id ? s.statuses[id] ?? null : null));
}
export function useCost(id: string | null): CostTick | null {
  return useStore(s => (id ? s.costs[id] ?? null : null));
}
export function useSpending(id: string | null): boolean {
  return useStore(s => (id ? (s.spending[id] ?? 0) > 0 : false));
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
