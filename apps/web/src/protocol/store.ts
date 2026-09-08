// SPDX-License-Identifier: AGPL-3.0-only
// Zustand store fed by one ProtocolClient + typed React hooks: the stable
// contract components code against.
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { NOTIFY_ME, applyPreferencesPatch, foldThreads, isLocalWorkspace, threadFromHash, workspaceFromHash, type Capabilities, type HarnessCatalog, type PortForward, type Preferences, type PreferencesPatch, type SessionView, type ThreadView, type WorkspaceCreateStage, type WorkspaceLook, type WorkspacePhase, type WorkspaceSize, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { noSuchThreadLine, renameNotTakenLine } from "../actions/format.js";
import { sidebarWorkspaceOrder } from "../adapt/workspaces.js";
import { DisconnectedError, RequestError, type Api, type ConnStatus, type ProtocolEvent } from "./client.js";
import { lastWorkspaceId, rememberWorkspace } from "./lastWorkspace.js";
import { clearLegacyPreferences, legacyPreferences } from "./legacyPreferences.js";
import { bootPreferences, rememberFirstPaint } from "./firstPaint.js";
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
  /** The person's view preferences, the host's one record; until the host answers, the defaults with what this browser
   * kept of the last record, so the first paint is the side, the width and the body the person picked. */
  preferences: Preferences;
  /** Whether the centre shows the settings page in place of the selected workspace's thread. */
  settingsOpen: boolean;
  bind(api: Api): void;
  noteGap(): void;
  /** Mirrors the client's status; live with an api bound pulls list and statuses again so a reconnect converges. */
  setConn(conn: ConnStatus): void;
  /** Also leaves the settings page: every road to a workspace lands on its thread. */
  select(id: string | null, threadId?: string | null): void;
  openSettings(): void;
  closeSettings(): void;
  toggleSettings(): void;
  /** Paints the patch at once and sends it; the host's answer settles the record, a refusal is a toast and the host's record is read again. */
  setPreferences(patch: PreferencesPatch): Promise<void>;
  /** Starts a create from the golden head, or from `golden` (a project golden's snapshot) when given, selects its row,
   * and follows it through the stage events; resolves with the runtime's id for the new workspace, or null when the
   * create was refused. */
  createWorkspace(name: string, golden?: string, size?: WorkspaceSize): Promise<string | null>;
  /** Makes this computer the host's local workspace and selects it, or selects the one it already is: there is one
   * per host, so a second pick is a selection, not a create. Null when the road is not there or the host refused,
   * whose own sentence lands as the toast. */
  createLocalWorkspace(): Promise<string | null>;
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
  /** Names the thread's harness session through the runtime, which writes it into the harness's own store: the
   * machine comes up first, as the command line's own rename does, then the name goes, then the workspace's rows are
   * reloaded so the sidebar shows it. True once the store took the name; an answer that named nothing and a failure
   * are false and a toast, so the caller can leave the name where a person can still see it. */
  renameThread(opts: { sessionId: string; workspaceId: string; harness: string; title: string }): Promise<boolean>;
  /** Names the workspace through the runtime, which holds the name on this computer, and puts the record it answers
   * with in place of the row. True once the runtime took the name; a refusal (a name another workspace holds, a blank
   * one) is false and a toast, so the caller can leave the name where a person can still see it. */
  renameWorkspace(opts: { workspaceId: string; name: string }): Promise<boolean>;
  /** Sets the workspace's hue or its glyph through the runtime, which holds them beside the record, and puts what it
   * answers with on the row. A key left out keeps that fact as it is and null clears it. False on a client without
   * the verb or a refusal, which lands in the toast. */
  setWorkspaceLook(opts: { workspaceId: string; look: WorkspaceLook }): Promise<boolean>;
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

/** The thread the page's address names, when the workspace the page opens on has a session of that thread; a thread
 * the list does not carry opens the workspace alone, and says so. */
function addressedThread(workspaceId: string | null, rows: readonly SessionView[]): { threadId: string | null; toast?: string } {
  const found = typeof window === "undefined" ? undefined : threadFromHash(window.location.hash);
  if (found === undefined || found.workspaceId !== workspaceId) return { threadId: null };
  if (rows.some(r => r.workspaceId === workspaceId && r.threadId === found.threadId)) return { threadId: found.threadId };
  return { threadId: null, toast: noSuchThreadLine(found.threadId) };
}

/** The workspace the person had open last, when the list still has it. */
function remembered(workspaces: readonly WorkspaceView[]): string | undefined {
  const id = lastWorkspaceId();
  return id !== undefined && workspaces.some(w => w.id === id) ? id : undefined;
}

/** The sidebar's top row: the one fallback for a selection with nothing to go on. */
function firstRow(s: Pick<State, "workspaces" | "statuses" | "sessions">): string | null {
  return sidebarWorkspaceOrder(s)[0] ?? null;
}

let creationSeq = 0;
/** Sets on their way to the host. While one is, a reply or a preferences.changed for an earlier set would paint an
 * older record over the one the person sees; the last reply, or the record read after a refusal, settles it. */
let preferenceSetsInFlight = 0;

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

  // wake-via-resurrect and upgrade replace the machine, so those events carry a new machineId; gone carries the
  // words, and any other phase drops the ones the view was holding, since a record that left gone has none to show
  const setPhase = (id: string, phase: WorkspacePhase, machineId?: string, gone?: string): void => {
    const words = phase !== "gone" ? { gone: undefined } : gone !== undefined ? { gone } : {};
    const patch = { phase, ...(machineId !== undefined ? { machineId } : {}), ...words };
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
    void api
      .preferences?.()
      .then(preferences => {
        if (preferenceSetsInFlight === 0) set({ preferences });
        // What this browser kept before the record existed goes onto the record once, then the old keys go.
        const legacy = legacyPreferences(window.localStorage);
        if (legacy !== null) void get().setPreferences(legacy).then(() => clearLegacyPreferences(window.localStorage));
      })
      .catch(() => {});
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
    preferences: bootPreferences(),
    settingsOpen: false,
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
    select(id, threadId = null) { set({ selectedId: id, selectedThreadId: threadId, settingsOpen: false }); },
    // The page is a labs surface, so every road to it (the chord, the palette row) is shut in one place.
    openSettings() { if (get().preferences.labs) set({ settingsOpen: true }); },
    closeSettings() { set({ settingsOpen: false }); },
    toggleSettings() { set(s => ({ settingsOpen: s.preferences.labs && !s.settingsOpen })); },
    async setPreferences(patch) {
      const api = get().api;
      set(s => ({ preferences: applyPreferencesPatch(s.preferences, patch) }));
      if (!api?.setPreferences) return;
      preferenceSetsInFlight++;
      try {
        const preferences = await api.setPreferences(patch);
        if (--preferenceSetsInFlight === 0) set({ preferences });
      } catch (e) {
        preferenceSetsInFlight--;
        if (e instanceof DisconnectedError) return;
        set({ toast: `settings: ${e instanceof Error ? e.message : String(e)}` });
        if (preferenceSetsInFlight === 0) void api.preferences?.().then(preferences => set({ preferences })).catch(() => {});
      }
    },
    async createWorkspace(name, golden, size) {
      if (!get().api) return null;
      const key = `creating:${++creationSeq}`;
      set(s => ({ creations: [...s.creations, { key, name, ...(golden !== undefined ? { golden } : {}), ...(size !== undefined ? { size } : {}), workspaceId: null, lines: NO_LINES, failed: null }], selectedId: key, selectedThreadId: null }));
      return runCreation(key, name, golden, size);
    },
    async createLocalWorkspace() {
      const api = get().api;
      if (api?.createLocalWorkspace === undefined) return null;
      // One local workspace per host: the second pick is the row this computer already is.
      const existing = get().workspaces.find(w => isLocalWorkspace(w));
      if (existing !== undefined) {
        get().select(existing.id);
        return existing.id;
      }
      try {
        const workspace = await api.createLocalWorkspace();
        set(s => (s.workspaces.some(w => w.id === workspace.id) ? {} : { workspaces: [...s.workspaces, workspace].sort((a, b) => a.id.localeCompare(b.id)) }));
        get().select(workspace.id);
        return workspace.id;
      } catch (e) {
        // This computer forks nothing and boots nothing, so there is no creation row to carry a refusal: the host's
        // own sentence is what the person reads, as the command line gives it.
        if (!(e instanceof DisconnectedError)) set({ toast: e instanceof Error ? e.message : String(e) });
        return null;
      }
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
        selectedId: s.selectedId === key ? firstRow(s) : s.selectedId,
      }));
    },
    async refresh() {
      const api = get().api;
      if (!api) return;
      const [workspaces, rows] = await Promise.all([api.listWorkspaces(), api.listSessions().catch(() => NO_SESSIONS)]);
      set(s => {
        const sessions = groupSessions(rows);
        const selectedId = s.selectedId ?? addressed(workspaces) ?? remembered(workspaces) ?? firstRow({ workspaces, statuses: s.statuses, sessions });
        const thread = s.selectedId === null ? addressedThread(selectedId, rows) : { threadId: s.selectedThreadId };
        return { workspaces, sessions, ready: true, selectedId, selectedThreadId: thread.threadId, ...(thread.toast !== undefined ? { toast: thread.toast } : {}) };
      });
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
    async renameThread({ sessionId, workspaceId, harness, title }) {
      const api = get().api;
      if (!api?.renameSession) return false;
      try {
        // The store the name goes into is on the machine, so a napping one is woken first and its reply repaints the
        // row; every client that can rename can wake, since wake is not an optional verb.
        const workspace = get().workspaces.find(w => w.id === workspaceId);
        if (workspace !== undefined && workspace.phase !== "running") get().applyWorkspace(await api.wake(workspaceId));
        const { outcome, error } = await api.renameSession(sessionId, title);
        if (outcome !== "renamed") {
          set({ toast: renameNotTakenLine(harness, outcome, error) });
          return false;
        }
        await get().reloadSessions(workspaceId);
        return true;
      } catch (e: unknown) {
        if (!(e instanceof DisconnectedError)) set({ toast: `${title}: ${e instanceof Error ? e.message : String(e)}` });
        return false;
      }
    },
    async renameWorkspace({ workspaceId, name }) {
      const api = get().api;
      if (!api?.renameWorkspace) return false;
      try {
        get().applyWorkspace(await api.renameWorkspace(workspaceId, name));
        return true;
      } catch (e: unknown) {
        if (!(e instanceof DisconnectedError)) set({ toast: e instanceof Error ? e.message : String(e) });
        return false;
      }
    },
    async setWorkspaceLook({ workspaceId, look }) {
      const api = get().api;
      if (!api?.setWorkspaceLook) return false;
      try {
        const workspace = await api.setWorkspaceLook(workspaceId, look);
        // The record answers with the whole look, and a cleared fact is absent from it, so the row takes it the way
        // the event does rather than through a merge, which cannot unset a key.
        get().applyEvent({ type: "workspace.look", workspaceId, tint: workspace.tint ?? null, glyph: workspace.glyph ?? null });
        return true;
      } catch (e: unknown) {
        if (!(e instanceof DisconnectedError)) set({ toast: e instanceof Error ? e.message : String(e) });
        return false;
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
        case "workspace.renamed":
          // The record alone changed: the row and its status take the name, and nothing about the machine moves.
          set(s => ({
            workspaces: s.workspaces.map(w => (w.id === e.workspaceId ? { ...w, name: e.name } : w)),
            statuses: s.statuses[e.workspaceId] ? { ...s.statuses, [e.workspaceId]: { ...s.statuses[e.workspaceId]!, name: e.name } } : s.statuses,
          }));
          return;
        case "workspace.look": {
          // Both facts travel whole, so a cleared one leaves the record rather than lingering under a merge.
          const put = <T extends WorkspaceView>(w: T): T => {
            const { tint: _tint, glyph: _glyph, ...rest } = w;
            return { ...rest, ...(e.tint !== null ? { tint: e.tint } : {}), ...(e.glyph !== null ? { glyph: e.glyph } : {}) } as T;
          };
          set(s => ({
            workspaces: s.workspaces.map(w => (w.id === e.workspaceId ? put(w) : w)),
            statuses: s.statuses[e.workspaceId] ? { ...s.statuses, [e.workspaceId]: put(s.statuses[e.workspaceId]!) } : s.statuses,
          }));
          return;
        }
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
        case "preferences.changed":
          if (preferenceSetsInFlight === 0) set({ preferences: e.preferences });
          return;
        default:
          return;
      }
    },
  };
});

// Every road to a workspace (a click, a chord, a finished creation, the boot fallback) lands here; a creation row is not a workspace yet.
useStore.subscribe((s, prev) => {
  if (s.selectedId !== prev.selectedId && s.selectedId !== null && s.workspaces.some(w => w.id === s.selectedId)) rememberWorkspace(s.selectedId);
});
// Every change to the record, the host's or a pick painted ahead of it, is what the next load paints first.
useStore.subscribe((s, prev) => {
  if (s.preferences !== prev.preferences) rememberFirstPaint(s.preferences);
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
export function usePreferences(): Preferences { return useStore(s => s.preferences); }
/** Whether this host offers the surfaces still being worked on; the record's one field, read by every surface that hides. */
export function useLabs(): boolean { return useStore(s => s.preferences.labs); }
export function useSettingsOpen(): boolean { return useStore(s => s.settingsOpen); }
export function useForwards(): PortForward[] { return useStore(s => s.forwards); }
/** Whether localhost:port on this computer is a page of that workspace to open: a printed link, not a sign-in callback. */
export function useForwarded(workspaceId: string | null, port: number | null): boolean {
  return useStore(s => workspaceId !== null && port !== null && s.forwards.some(f => f.workspaceId === workspaceId && f.port === port && f.kind === "url"));
}
export function useCapabilities(): Capabilities | null { return useStore(s => s.capabilities); }
/** The catalogs a composer reads: the workspace's machine's once it answered, else the runtime's table. */
export function useHarnessCatalogs(workspaceId: string | null): HarnessCatalog[] {
  return useStore(s => catalogsIn(s, workspaceId));
}
export function useHarnessCatalog(harness: string, workspaceId: string | null = null): HarnessCatalog | null {
  return useStore(s => catalogIn(s, workspaceId, harness));
}

type Catalogs = Pick<State, "harnesses" | "harnessesByWorkspace">;

/** The one rule for which catalogs answer for a workspace, so a surface reading many workspaces' rows and one
 * reading its own read the same thing. */
export const catalogsIn = (s: Catalogs, workspaceId: string | null): HarnessCatalog[] =>
  (workspaceId !== null ? s.harnessesByWorkspace[workspaceId] : undefined) ?? s.harnesses;
export const catalogIn = (s: Catalogs, workspaceId: string | null, harness: string): HarnessCatalog | null =>
  catalogsIn(s, workspaceId).find(c => c.harness === harness) ?? null;
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
