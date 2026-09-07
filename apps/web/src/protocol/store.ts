// SPDX-License-Identifier: AGPL-3.0-only
// Zustand store fed by one ProtocolClient + typed React hooks: the stable
// contract components code against.
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { NOTIFY_ME, foldThreads, workspaceFromHash, type Capabilities, type HarnessCatalog, type PortForward, type SessionView, type ThreadView, type WorkspaceCreateStage, type WorkspacePhase, type WorkspaceSize, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { DisconnectedError, RequestError, type Api, type ConnStatus, type ProtocolEvent } from "./client.js";
import { useSignInStore } from "../shell/signInStore.js";

export interface CostTick {
  rateUsdPerHour: number;
  accruedUsd: number;
  at: string;
}

/** One line of a create's stage log, stamped with the wall clock when it arrived here. */
export interface CreationLine {
  readonly stage: WorkspaceCreateStage;
  readonly message: string;
  readonly at: string;
  readonly elapsedMs: number;
  readonly notice?: string;
}

/** A workspace being created: the sidebar row and the center view read it until workspace.created replaces it. */
export interface Creation {
  /** What select() takes for it; stable from the click through the runtime's first stage event. */
  readonly key: string;
  readonly name: string;
  /** The snapshot the create forks, when it is not the golden's head: a project golden's. */
  readonly golden?: string;
  /** The size the person picked; absent, the golden's. */
  readonly size?: WorkspaceSize;
  /** The id the runtime minted, known from its first stage event. */
  readonly workspaceId: string | null;
  readonly lines: ReadonlyArray<CreationLine>;
  /** Set once the create was refused; the lines keep the failing one. */
  readonly failed: CreateRefusal | null;
}

export interface CreateRefusal {
  readonly title: string;
  readonly detail: string;
}

export function explainCreateRefusal(error: unknown): CreateRefusal {
  const message = error instanceof Error ? error.message : String(error);
  // The runtime names the machines holding the slots and the move that frees one; a second wording here would say less.
  if (error instanceof RequestError && error.kind === "concurrency") {
    return { title: "The provider refused: machine cap reached", detail: message };
  }
  if (error instanceof DisconnectedError) {
    return { title: "Not connected to the runtime", detail: message };
  }
  return { title: "Could not create the workspace", detail: message };
}

interface State {
  api: Api | null;
  /** The runtime socket as the client reports it; the shell's banner reads this. */
  conn: ConnStatus;
  /** Backend feature flags; null until the first reply. Gate upgrade/resize on these. */
  capabilities: Capabilities | null;
  /** What each harness's CLI takes at launch, from the runtime's table; empty until it answers, and the composer shows no pickers. */
  harnesses: HarnessCatalog[];
  /** The same, as the binaries on a workspace's machine reported them; set once loadHarnesses got an answer for it. */
  harnessesByWorkspace: Record<string, HarnessCatalog[]>;
  workspaces: WorkspaceView[];
  statuses: Record<string, WorkspaceStatus>;
  costs: Record<string, CostTick>;
  /** Live session count per workspace; > 0 renders the spend-pulse. */
  spending: Record<string, number>;
  /** Guest ports the host forwards to localhost here, from the host's list and its forward events. */
  forwards: PortForward[];
  toast: string | null;
  /** A workspace id, or a creation's key while that create runs. */
  selectedId: string | null;
  /** A thread of the selected workspace the person picked in the sidebar; null shows the workspace's latest thread. */
  selectedThreadId: string | null;
  creations: Creation[];
  sessions: Record<string, SessionView[]>;
  ready: boolean;
  /** How many reconnects the runtime could not replay events for; anything built from sessions.history reloads when it moves. */
  gaps: number;
  bind(api: Api): void;
  noteGap(): void;
  /** Mirrors the client's status; live with an api bound pulls list and statuses again so a reconnect converges. */
  setConn(conn: ConnStatus): void;
  select(id: string | null, threadId?: string | null): void;
  /** Starts a create from the golden head, or from `golden` (a project golden's snapshot) when given, selects its row,
   * and follows it through the stage events; resolves with the runtime's id for the new workspace, or null when the
   * create was refused. */
  createWorkspace(name: string, golden?: string, size?: WorkspaceSize): Promise<string | null>;
  /** Runs a failed creation again under the same row. */
  retryCreation(key: string): Promise<void>;
  dismissCreation(key: string): void;
  refresh(): Promise<void>;
  /** Optimistic nap/wake: paint now, reconcile on the event, revert + toast on failure. */
  toggle(id: string): Promise<void>;
  /** The wake alone: what every Wake button calls, whatever the row says. A running workspace is left as it is. */
  wake(id: string): Promise<void>;
  /** A workspace view the runtime handed back to a caller, over the one in the rail: no event carries the image a
   * workspace forks from, so a move to a newer golden version would read stale until the next full refresh. */
  applyWorkspace(workspace: WorkspaceView): void;
  /** The row leaves on the host's forward.close; a refusal is a toast. */
  stopForward(workspaceId: string, port: number): Promise<void>;
  clearToast(): void;
  applyEvent(e: ProtocolEvent): void;
  /** Rows come from the runtime (only it knows harness and final status); events say when to ask. */
  reloadSessions(workspaceId: string): Promise<void>;
  /** Asks the runtime for the catalogs as the workspace's machine reports them; a refusal leaves the table's in place. */
  loadHarnesses(workspaceId: string): Promise<void>;
}

const NO_SESSIONS: SessionView[] = [];

function groupSessions(rows: SessionView[]): Record<string, SessionView[]> {
  const out: Record<string, SessionView[]> = {};
  for (const r of rows) (out[r.workspaceId] ??= []).push(r);
  return out;
}

const NO_LINES: CreationLine[] = [];

/** The workspace the page's address opens on, when the list still has it: wsp init writes it after its first fork.
 * An id that is gone falls through to the first row, as an address with no workspace in it does. */
function addressed(workspaces: readonly WorkspaceView[]): string | undefined {
  const id = typeof window === "undefined" ? undefined : workspaceFromHash(window.location.hash);
  return id !== undefined && workspaces.some(w => w.id === id) ? id : undefined;
}

let creationSeq = 0;

export const useStore = create<State>((set, get) => {
  const patchCreation = (key: string, patch: (c: Creation) => Creation): void => {
    set(s => ({ creations: s.creations.map(c => (c.key === key ? patch(c) : c)) }));
  };
  /** The row leaves with its workspace in place of it; the selection follows. */
  const finishCreation = (key: string, workspaceId: string): void => {
    set(s => ({
      creations: s.creations.filter(c => c.key !== key),
      selectedId: s.selectedId === key ? workspaceId : s.selectedId,
    }));
  };
  const runCreation = async (key: string, name: string, golden?: string, size?: WorkspaceSize): Promise<string | null> => {
    const api = get().api;
    if (!api) return null;
    try {
      const { notice, ...workspace } = await (golden === undefined ? api.createFromGoldenHead(name, size) : api.createWorkspace(golden, name, size));
      if (notice !== undefined) set({ toast: notice });
      // The created event normally lands first; when the reply beats it, the row still has a workspace to become.
      set(s => (s.workspaces.some(w => w.id === workspace.id) ? {} : { workspaces: [...s.workspaces, workspace].sort((a, b) => a.id.localeCompare(b.id)) }));
      finishCreation(key, workspace.id);
      return workspace.id;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      patchCreation(key, c => ({
        ...c,
        failed: explainCreateRefusal(e),
        lines: c.lines.at(-1)?.stage === "failed" ? c.lines : [...c.lines, { stage: "failed", message, at: new Date().toISOString(), elapsedMs: c.lines.at(-1)?.elapsedMs ?? 0 }],
      }));
      return null;
    }
  };

  // wake-via-resurrect and upgrade replace the machine, so those events carry a new machineId; gone carries the words
  const setPhase = (id: string, phase: WorkspacePhase, machineId?: string, gone?: string): void => {
    const patch = { phase, ...(machineId !== undefined ? { machineId } : {}), ...(gone !== undefined ? { gone } : {}) };
    set(s => ({
      workspaces: s.workspaces.map(w => (w.id === id ? { ...w, ...patch } : w)),
      statuses: s.statuses[id] ? { ...s.statuses, [id]: { ...s.statuses[id]!, ...patch } } : s.statuses,
    }));
  };

  // The optimistic phase paints at once; the runtime's own pushes (pausing, napping, waking, running) reconcile it.
  const move = async (id: string, to: "pausing" | "waking"): Promise<void> => {
    const api = get().api;
    const w = get().workspaces.find(x => x.id === id);
    if (!api || !w) return;
    setPhase(id, to);
    try {
      await (to === "pausing" ? api.nap(id) : api.wake(id));
    } catch (e) {
      setPhase(id, w.phase);
      if (!(e instanceof DisconnectedError)) set({ toast: `${w.name}: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  // What bind fetches and a reconnect fetches again: the list plus the status snapshot that also arms status.subscribe.
  const pull = (api: Api): void => {
    void get().refresh().catch(() => {});
    void api
      .watchStatuses()
      .then(statuses => set({ statuses: Object.fromEntries(statuses.map(s => [s.id, s])) }))
      .catch((e: unknown) => set({ toast: `live status unavailable: ${e instanceof Error ? e.message : String(e)}` }));
    // A refused list clears the rows: a forward that closed while the socket was down must not stay listed.
    void api
      .listForwards?.()
      .then(forwards => set({ forwards }))
      .catch((e: unknown) => set({ forwards: [], toast: `forward list unavailable: ${e instanceof Error ? e.message : String(e)}` }));
  };

  return {
    api: null,
    conn: "connecting",
    capabilities: null,
    harnesses: [],
    harnessesByWorkspace: {},
    workspaces: [],
    statuses: {},
    costs: {},
    spending: {},
    forwards: [],
    toast: null,
    selectedId: null,
    selectedThreadId: null,
    creations: [],
    sessions: {},
    ready: false,
    gaps: 0,
    noteGap() { set(s => ({ gaps: s.gaps + 1 })); },
    bind(api) {
      set({ api });
      api.subscribe(e => get().applyEvent(e));
      void api
        .capabilities()
        .then(capabilities => set({ capabilities }))
        .catch(() => {});
      void api
        .listHarnesses?.()
        .then(harnesses => set({ harnesses }))
        .catch(() => {});
      pull(api);
    },
    setConn(conn) {
      set({ conn });
      const api = get().api;
      if (conn === "live" && api) pull(api);
    },
    select(id, threadId = null) { set({ selectedId: id, selectedThreadId: threadId }); },
    async createWorkspace(name, golden, size) {
      if (!get().api) return null;
      const key = `creating:${++creationSeq}`;
      set(s => ({ creations: [...s.creations, { key, name, ...(golden !== undefined ? { golden } : {}), ...(size !== undefined ? { size } : {}), workspaceId: null, lines: NO_LINES, failed: null }], selectedId: key, selectedThreadId: null }));
      return runCreation(key, name, golden, size);
    },
    async retryCreation(key) {
      const creation = get().creations.find(c => c.key === key);
      if (!creation) return;
      patchCreation(key, c => ({ ...c, workspaceId: null, lines: NO_LINES, failed: null }));
      await runCreation(key, creation.name, creation.golden, creation.size);
    },
    dismissCreation(key) {
      set(s => ({
        creations: s.creations.filter(c => c.key !== key),
        selectedId: s.selectedId === key ? s.workspaces[0]?.id ?? null : s.selectedId,
      }));
    },
    async refresh() {
      const api = get().api;
      if (!api) return;
      const [workspaces, rows] = await Promise.all([api.listWorkspaces(), api.listSessions().catch(() => NO_SESSIONS)]);
      set(s => ({ workspaces, sessions: groupSessions(rows), ready: true, selectedId: s.selectedId ?? addressed(workspaces) ?? workspaces[0]?.id ?? null }));
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
    async loadHarnesses(workspaceId) {
      const api = get().api;
      if (!api?.listHarnesses) return;
      try {
        const harnesses = await api.listHarnesses(workspaceId);
        set(s => ({ harnessesByWorkspace: { ...s.harnessesByWorkspace, [workspaceId]: harnesses } }));
      } catch {
        // the table's catalogs stand
      }
    },
    async toggle(id) {
      const w = get().workspaces.find(x => x.id === id);
      if (!w) return;
      if (w.phase === "running") await move(id, "pausing");
      else await get().wake(id);
    },
    async wake(id) {
      const w = get().workspaces.find(x => x.id === id);
      if (!w || w.phase === "running") return;
      await move(id, "waking");
    },
    async stopForward(workspaceId, port) {
      const api = get().api;
      if (!api?.stopForward) return;
      try {
        await api.stopForward(workspaceId, port);
      } catch (e) {
        if (!(e instanceof DisconnectedError)) set({ toast: `localhost:${port}: ${e instanceof Error ? e.message : String(e)}` });
      }
    },
    clearToast() { set({ toast: null }); },
    applyWorkspace(workspace) {
      set(s => ({
        workspaces: s.workspaces.map(w => (w.id === workspace.id ? { ...w, ...workspace } : w)),
        statuses: s.statuses[workspace.id] ? { ...s.statuses, [workspace.id]: { ...s.statuses[workspace.id]!, ...workspace } } : s.statuses,
      }));
    },
    applyEvent(e) {
      switch (e.type) {
        case "workspace.deleted":
          set(s => {
            const { [e.workspaceId]: _s, ...statuses } = s.statuses;
            const { [e.workspaceId]: _c, ...costs } = s.costs;
            const { [e.workspaceId]: _p, ...spending } = s.spending;
            const { [e.workspaceId]: _r, ...sessions } = s.sessions;
            return {
              workspaces: s.workspaces.filter(x => x.id !== e.workspaceId),
              statuses,
              costs,
              spending,
              sessions,
              forwards: s.forwards.filter(f => f.workspaceId !== e.workspaceId),
            };
          });
          return;
        case "forward.open":
          set(s => ({ forwards: [...s.forwards.filter(f => !(f.workspaceId === e.forward.workspaceId && f.port === e.forward.port)), e.forward] }));
          return;
        case "forward.close":
          set(s => ({ forwards: s.forwards.filter(f => !(f.workspaceId === e.workspaceId && f.port === e.port)) }));
          useSignInStore.getState().portClosed(e.workspaceId, e.port);
          return;
        case "workspace.creating": {
          const line: CreationLine = { stage: e.stage, message: e.message, at: new Date().toISOString(), elapsedMs: e.elapsedMs, ...(e.notice !== undefined ? { notice: e.notice } : {}) };
          set(s => {
            // Ours is matched by the id once known, before that by the name it was asked for; another client's create shows up
            // too. Two clients creating the same name at once can swap logs until the reply lands, and workspace.created
            // settles which row is whose; the runtime's id is not known here any earlier than its first stage.
            const own = s.creations.find(c => c.workspaceId === e.workspaceId) ?? s.creations.find(c => c.workspaceId === null && c.name === e.name && c.failed === null);
            const failed = e.stage === "failed" ? { title: "Could not create the workspace", detail: e.message } : null;
            if (own === undefined) {
              return { creations: [...s.creations, { key: `creating:${e.workspaceId}`, name: e.name, workspaceId: e.workspaceId, lines: [line], failed }] };
            }
            return { creations: s.creations.map(c => (c === own ? { ...c, workspaceId: e.workspaceId, lines: [...c.lines, line], failed: c.failed ?? failed } : c)) };
          });
          return;
        }
        case "workspace.created":
          set(s => {
            const rest = s.workspaces.filter(x => x.id !== e.workspace.id);
            const creation = s.creations.find(c => c.workspaceId === e.workspace.id);
            return {
              workspaces: [...rest, e.workspace].sort((a, b) => a.id.localeCompare(b.id)),
              creations: s.creations.filter(c => c !== creation),
              selectedId: creation !== undefined && s.selectedId === creation.key ? e.workspace.id : s.selectedId,
            };
          });
          return;
        // napped/woken carry only ids; they are also the optimistic toggle's reconcile.
        case "workspace.napped":
          setPhase(e.workspaceId, "napping");
          return;
        case "workspace.gone":
          setPhase(e.workspaceId, "gone", undefined, e.reason);
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
          // The runtime re-asks the binary at a start, so a Claude Code upgrade on the machine shows within its TTL.
          void get().loadHarnesses(e.workspaceId);
          return;
        }
        case "session.done":
          // The reply is in, but the row stays running until the process exits (session.end): a turn is not over while
          // its agent keeps working, and a send that met a done-but-running row would be one the runtime refuses.
          return;
        case "session.end":
          set(s => ({ spending: { ...s.spending, [e.workspaceId]: Math.max(0, (s.spending[e.workspaceId] ?? 0) - 1) } }));
          void get().reloadSessions(e.workspaceId);
          return;
        case "session.notify":
          if (e.notify === NOTIFY_ME) set({ toast: e.text });
          return;
        default:
          return;
      }
    },
  };
});

export function useSelectedId(): string | null { return useStore(s => s.selectedId); }
export function useSelectedThreadId(): string | null { return useStore(s => s.selectedThreadId); }
/** The selected workspace's id, or null while a creation row is selected: no command may act on a creation's key. */
export function useSelectedWorkspaceId(): string | null {
  return useStore(s => (s.selectedId !== null && s.creations.some(c => c.key === s.selectedId) ? null : s.selectedId));
}
export function useCreation(key: string | null): Creation | null {
  return useStore(s => (key ? s.creations.find(c => c.key === key) ?? null : null));
}
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
export function useReady(): boolean { return useStore(s => s.ready); }
export function useForwards(): PortForward[] { return useStore(s => s.forwards); }
/** Whether localhost:port on this computer is a page of that workspace to open: a printed link, not a sign-in callback. */
export function useForwarded(workspaceId: string | null, port: number | null): boolean {
  return useStore(s => workspaceId !== null && port !== null && s.forwards.some(f => f.workspaceId === workspaceId && f.port === port && f.kind === "url"));
}
export function useCapabilities(): Capabilities | null { return useStore(s => s.capabilities); }
/** The catalogs a composer reads: the workspace's machine's once it answered, else the runtime's table. */
export function useHarnessCatalogs(workspaceId: string | null): HarnessCatalog[] {
  return useStore(s => (workspaceId !== null ? s.harnessesByWorkspace[workspaceId] : undefined) ?? s.harnesses);
}
export function useHarnessCatalog(harness: string, workspaceId: string | null = null): HarnessCatalog | null {
  return useStore(s => ((workspaceId !== null ? s.harnessesByWorkspace[workspaceId] : undefined) ?? s.harnesses).find(c => c.harness === harness) ?? null);
}
/** The thread the centre shows for a workspace: the one picked in the sidebar, else the workspace's latest; null with no threads yet. */
export function useOpenThread(workspaceId: string | null): ThreadView | null {
  const sessions = useStore(s => (workspaceId !== null ? s.sessions[workspaceId] : undefined) ?? NO_SESSIONS);
  const threadId = useSelectedThreadId();
  return useMemo(() => {
    const threads = foldThreads(sessions);
    return (threadId !== null ? threads.find(t => t.threadId === threadId) : threads.at(-1)) ?? null;
  }, [sessions, threadId]);
}
/** The workspace's most recent session row, running or not; null before its first session this runtime remembers. */
export function useLatestSession(id: string | null): SessionView | null {
  return useStore(s => (id ? s.sessions[id]?.at(-1) ?? null : null));
}

/** Subscribe a component to raw protocol events (the thread, terminal and browser surfaces use this). */
export function useProtocolEvents(fn: (e: ProtocolEvent) => void): void {
  const api = useStore(s => s.api);
  useEffect(() => (api ? api.subscribe(fn) : undefined), [api, fn]);
}
