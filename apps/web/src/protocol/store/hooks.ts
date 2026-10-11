// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo } from "react";
import { foldThreads, workspaceStateOf, type AbsentComputer, type BringBackResult, type Capabilities, type GoldenStageEvent, type HarnessCatalog, type InitJob, type PlaceView, type PortForward, type Preferences, type ProjectView, type SessionView, type ThreadView, type WorkspaceState, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { deriveSidebarProjects } from "../../adapt/workspaces.js";
import type { Launch, SidebarProjectSnapshot } from "../../adapt/view-model.js";
import type { ProtocolEvent } from "../client.js";
import type { Failure } from "../failure.js";
import { absenceOf } from "../../settings/places.js";
import { useStore } from "./useStore.js";
import { withHeldThreads } from "./heldKeys.js";
import { catalogIn, catalogsIn, NO_SESSIONS, pauseModesOf, selectedWorkspaceIdOf, threadRows } from "./selectors.js";
import type { CostTick, Creation } from "./types.js";

/** Every workspace with its threads, as the sidebar's rows read them, for the surfaces that need the whole fleet
 * rather than one workspace: the sidebar, the palette, the rows a transcript draws for the threads it opened, and
 * the header's name for the thread that opened this one. */
export function useSidebarProjects(): SidebarProjectSnapshot[] {
  const workspaces = useStore(s => s.workspaces);
  const statuses = useStore(s => s.statuses);
  const sessions = useStore(s => s.sessions);
  const held = useStore(s => s.heldKeys);
  const landings = useStore(s => s.landings);
  const derived = useMemo(() => deriveSidebarProjects({ workspaces, statuses, sessions, pauseModes: pauseModesOf(landings) }), [workspaces, statuses, sessions, landings]);
  return useMemo(() => withHeldThreads(derived, held), [derived, held]);
}

/** Every workspace's send in flight, for the sidebar, which reads them beside the rows the runtime has written. */
export function useLaunches(): Record<string, Launch> {
  return useStore(s => s.launches);
}

export function useSelectedId(): string | null { return useStore(s => s.selectedId); }
export function useSelectedThreadId(): string | null { return useStore(s => s.selectedThreadId); }
export function useSelectedSubagent(): string | null { return useStore(s => s.selectedSubagent); }

export function useSelectedWorkspaceId(): string | null {
  return useStore(selectedWorkspaceIdOf);
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
/** The one state word for a workspace as this app knows it: its status when one has arrived, and the record's phase
 * alone until then, which reads a paused or unreachable machine as running. null while neither is known, which is
 * how a surface tells a workspace it has not been given yet from one it has. */
export function useWorkspaceState(id: string | null): WorkspaceState | null {
  const workspace = useWorkspace(id);
  const status = useStatus(id);
  const view = status ?? workspace;
  return view === null ? null : workspaceStateOf(view, status);
}
/** The one state of this workspace's computer while it is not answering, null while it is. Every surface that says
 * anything about an absent computer reads it here: the sidebar row, the composer's held send
 * and the terminal pane. The clock is the caller's: a surface that ticks passes its own, so it
 * cannot date the silence differently from the row beside it, and one that shows the sentence alone passes none
 * and is handed a reading with no figure, rather than a clock read on the render path that never ticks again. */
export function useAbsentComputer(id: string | null, nowMs: number | null = null): AbsentComputer | null {
  const workspace = useWorkspace(id);
  const status = useStatus(id);
  const places = usePlaces();
  return useMemo(() => absenceOf(places, workspace, status, nowMs), [places, workspace, status, nowMs]);
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
export function useSettingsOpen(): boolean { return useStore(s => s.settingsOpen); }
export function useForwards(): PortForward[] { return useStore(s => s.forwards); }
/** Whether localhost:port on this computer is a page of that workspace to open: a printed link, not a sign-in callback. */
export function useForwarded(workspaceId: string | null, port: number | null): boolean {
  return useStore(s => workspaceId !== null && port !== null && s.forwards.some(f => f.workspaceId === workspaceId && f.port === port && f.kind === "url"));
}
export function useCapabilities(): Capabilities | null { return useStore(s => s.capabilities); }
export function useInitJob(): InitJob | null { return useStore(s => s.initJob); }
export function useGoldenFrames(): Record<string, GoldenStageEvent[]> { return useStore(s => s.goldenFrames); }
/** The catalogs a composer reads: the workspace's machine's once it answered, else the runtime's table. */
export function useHarnessCatalogs(workspaceId: string | null): HarnessCatalog[] {
  return useStore(s => catalogsIn(s, workspaceId));
}
export function useHarnessCatalog(harness: string | null, workspaceId: string | null = null): HarnessCatalog | null {
  return useStore(s => (harness === null ? null : catalogIn(s, workspaceId, harness)));
}

/** The thread the centre shows for a workspace, which is the one the address names: none while the centre is on a
 * next thread's screen or on a view that has not settled on a thread yet, so a header can never name one thread
 * while the body shows another. */
export function useOpenThread(workspaceId: string | null): ThreadView | null {
  const sessions = useStore(s => (workspaceId !== null ? s.sessions[workspaceId] : undefined) ?? NO_SESSIONS);
  const threadId = useSelectedThreadId();
  return useMemo(() => (threadId === null ? null : foldThreads(sessions).find(t => t.threadId === threadId) ?? null), [sessions, threadId]);
}
/** Every turn the runtime holds for one thread, oldest first: what that thread has already run with, which is what a
 * composer reads its pickers off, its running turn included, so a second thread running in the same workspace paints
 * neither. A view holding no thread of its own carries the workspace's id as its key, which no row carries: there the
 * workspace's latest row is the turn that view shows and resumes, which is what the rest of this hook's readings take
 * it to be, and rows from before the runtime stamped a thread on them are only reachable that way. Empty for a thread
 * with no turn yet. */
export function useThreadSessions(workspaceId: string | null, threadKey: string): ReadonlyArray<SessionView> {
  const sessions = useStore(s => (workspaceId !== null ? s.sessions[workspaceId] : undefined) ?? NO_SESSIONS);
  return useMemo(() => threadRows(sessions, workspaceId, threadKey), [sessions, threadKey, workspaceId]);
}

/** Subscribe a component to raw protocol events (the thread, terminal and browser surfaces use this). */
export function useProtocolEvents(fn: (e: ProtocolEvent) => void): void {
  const api = useStore(s => s.api);
  useEffect(() => (api ? api.subscribe(fn) : undefined), [api, fn]);
}
export function usePlaces(): PlaceView[] { return useStore(s => s.places); }
export function useProjects(): ProjectView[] { return useStore(s => s.projects); }
/** What the last bring back on this workspace answered, for the row that reads it; undefined until one has. */
export function useBroughtBack(workspaceId: string): BringBackResult | undefined { return useStore(s => s.broughtBack[workspaceId]); }
export function usePlacesRead(): boolean { return useStore(s => s.placesRead); }
export function useProjectsRefused(): Failure | null { return useStore(s => s.projectsRefused); }
export function useProjectsRead(): boolean { return useStore(s => s.projectsRead); }
/** Whether the first run is the whole centre: this wsp holds no project and no workspace, and the host has
 * answered about both. The centre and the header read it here, so the bar cannot title an emptiness the centre is
 * already titling, and neither paints that screen over a host whose lists are still on their way. */
export function useFirstRun(): boolean {
  return useStore(s => s.ready && s.projectsRead && s.projectsRefused === null && s.projects.length === 0 && s.workspaces.length === 0);
}

/** The project whose New thread page the centre shows while no workspace is picked: the one opened, else the first.
 * The centre and the header read it here, so the page reads the same whether it was opened or fallen back to. */
export function useHomeProject(): ProjectView | undefined {
  return useStore(s => s.projects.find(p => p.id === s.projectHome) ?? s.projects[0]);
}
