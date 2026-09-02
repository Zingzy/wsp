// SPDX-License-Identifier: AGPL-3.0-only
// Zustand store fed by one ProtocolClient + typed React hooks: the stable
// contract components code against.
import { useEffect } from "react";
import { create } from "zustand";
import type { Capabilities, SessionView, WorkspacePhase, WorkspaceStatus, WorkspaceView } from "@wsp/protocol";
import type { Api, ConnStatus, ProtocolEvent } from "./client.js";

export interface CostTick {
  rateUsdPerHour: number;
  accruedUsd: number;
  at: string;
}

interface State {
  api: Api | null;
  /** The runtime socket as the client reports it; "closed" drives the disconnected banner. */
  conn: ConnStatus;
  /** Backend feature flags; null until the first reply. Gate upgrade/resize on these. */
  capabilities: Capabilities | null;
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
  setConn(conn: ConnStatus): void;
  select(id: string | null): void;
  refresh(): Promise<void>;
  /** Optimistic nap/wake: paint now, reconcile on the event, revert + toast on failure. */
  toggle(id: string): Promise<void>;
  createWorkspace(name: string): Promise<void>;
  clearToast(): void;
  applyEvent(e: ProtocolEvent): void;
  /** Rows come from the runtime (only it knows harness and final status); events say when to ask. */
  reloadSessions(workspaceId: string): Promise<void>;
}

const NO_SESSIONS: SessionView[] = [];

function groupSessions(rows: SessionView[]): Record<string, SessionView[]> {
  const out: Record<string, SessionView[]> = {};
  for (const r of rows) (out[r.workspaceId] ??= []).push(r);
  return out;
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
    conn: "connecting",
    capabilities: null,
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
        .capabilities()
        .then(capabilities => set({ capabilities }))
        .catch(() => {});
      void api
        .watchStatuses()
        .then(statuses => set({ statuses: Object.fromEntries(statuses.map(s => [s.id, s])) }))
        .catch((e: unknown) => set({ toast: `live status unavailable: ${e instanceof Error ? e.message : String(e)}` }));
    },
    setConn(conn) { set({ conn }); },
    select(id) { set({ selectedId: id }); },
    async refresh() {
      const api = get().api;
      if (!api) return;
      const [workspaces, rows] = await Promise.all([api.listWorkspaces(), api.listSessions().catch(() => NO_SESSIONS)]);
      set(s => ({ workspaces, sessions: groupSessions(rows), ready: true, selectedId: s.selectedId ?? workspaces[0]?.id ?? null }));
    },
    async reloadSessions(workspaceId) {
      const api = get().api;
      if (!api) return;
      try {
        const rows = await api.listSessions(workspaceId);
        set(s => ({ sessions: { ...s.sessions, [workspaceId]: rows } }));
      } catch {
        // the next session event asks again
      }
    },
    async toggle(id) {
      const api = get().api;
      const w = get().workspaces.find(x => x.id === id);
      if (!api || !w) return;
      const to: WorkspacePhase = w.phase === "running" ? "napping" : "waking";
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
            const { [e.workspaceId]: _r, ...sessions } = s.sessions;
            return { workspaces: s.workspaces.filter(x => x.id !== e.workspaceId), statuses, costs, spending, sessions };
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
        case "session.start": {
          // The next send resumes this id; the runtime persists it, the view learns it here.
          const remember = <T extends WorkspaceView>(w: T): T => (w.id === e.workspaceId ? { ...w, claudeSessionId: e.sessionId } : w);
          set(s => ({
            spending: { ...s.spending, [e.workspaceId]: (s.spending[e.workspaceId] ?? 0) + 1 },
            workspaces: s.workspaces.map(remember),
            statuses: s.statuses[e.workspaceId] ? { ...s.statuses, [e.workspaceId]: remember(s.statuses[e.workspaceId]!) } : s.statuses,
          }));
          void get().reloadSessions(e.workspaceId);
          return;
        }
        case "session.done":
          set(s => ({
            sessions: {
              ...s.sessions,
              [e.workspaceId]: (s.sessions[e.workspaceId] ?? NO_SESSIONS).map(r =>
                r.claudeSessionId === e.sessionId || r.id === e.sessionId ? { ...r, status: e.result.status } : r,
              ),
            },
          }));
          return;
        case "session.end":
          set(s => ({ spending: { ...s.spending, [e.workspaceId]: Math.max(0, (s.spending[e.workspaceId] ?? 0) - 1) } }));
          void get().reloadSessions(e.workspaceId);
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
  return useStore(s => (workspaceId ? s.sessions[workspaceId] ?? NO_SESSIONS : NO_SESSIONS));
}
export function useReady(): boolean { return useStore(s => s.ready); }
export function useCapabilities(): Capabilities | null { return useStore(s => s.capabilities); }

/** Subscribe a component to raw protocol events (terminal/chat/browser tabs use this). */
export function useProtocolEvents(fn: (e: ProtocolEvent) => void): void {
  const api = useStore(s => s.api);
  useEffect(() => (api ? api.subscribe(fn) : undefined), [api, fn]);
}
