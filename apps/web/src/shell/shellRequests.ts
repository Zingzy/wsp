// SPDX-License-Identifier: AGPL-3.0-only
// Requests the palette, the shortcuts and the action registries raise for
// another region to fulfil, as window events so the raiser does not own that
// region's state. The sidebar answers new-workspace, forget-workspace and the
// project trips with its dialogs and rename-workspace with the name box on
// that row; new-thread waits for a chat container to subscribe. Composer
// focus is held rather than broadcast: the workspace switch selects and asks
// in one handler, and the composer it names remounts after that handler
// returns.
import type { LookPart } from "@wsp/protocol";

const NEW_WORKSPACE_EVENT = "wsp:new-workspace";
const NEW_THREAD_EVENT = "wsp:new-thread";

export interface NewThreadRequest {
  readonly workspaceId: string;
}

export function requestNewWorkspace(): void {
  window.dispatchEvent(new CustomEvent(NEW_WORKSPACE_EVENT));
}

export function onNewWorkspaceRequest(listener: () => void): () => void {
  window.addEventListener(NEW_WORKSPACE_EVENT, listener);
  return () => window.removeEventListener(NEW_WORKSPACE_EVENT, listener);
}

export function requestNewThread(detail: NewThreadRequest): void {
  window.dispatchEvent(new CustomEvent(NEW_THREAD_EVENT, { detail }));
}

export function onNewThreadRequest(listener: (detail: NewThreadRequest) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<NewThreadRequest>).detail);
  window.addEventListener(NEW_THREAD_EVENT, handler);
  return () => window.removeEventListener(NEW_THREAD_EVENT, handler);
}

const FORGET_WORKSPACE_EVENT = "wsp:forget-workspace";

export interface ForgetWorkspaceRequest {
  readonly workspaceId: string;
}

/** Asks for the forget confirmation; the sidebar answers with its dialog. */
export function requestForgetWorkspace(workspaceId: string): void {
  window.dispatchEvent(new CustomEvent(FORGET_WORKSPACE_EVENT, { detail: { workspaceId } }));
}

export function onForgetWorkspaceRequest(listener: (detail: ForgetWorkspaceRequest) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<ForgetWorkspaceRequest>).detail);
  window.addEventListener(FORGET_WORKSPACE_EVENT, handler);
  return () => window.removeEventListener(FORGET_WORKSPACE_EVENT, handler);
}

const RENAME_WORKSPACE_EVENT = "wsp:rename-workspace";

export interface RenameWorkspaceRequest {
  readonly workspaceId: string;
}

/** Asks for the name box on the workspace's own row; the sidebar answers, since the row is the only editor. */
export function requestRenameWorkspace(workspaceId: string): void {
  window.dispatchEvent(new CustomEvent(RENAME_WORKSPACE_EVENT, { detail: { workspaceId } }));
}

export function onRenameWorkspaceRequest(listener: (detail: RenameWorkspaceRequest) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<RenameWorkspaceRequest>).detail);
  window.addEventListener(RENAME_WORKSPACE_EVENT, handler);
  return () => window.removeEventListener(RENAME_WORKSPACE_EVENT, handler);
}

const WORKSPACE_LOOK_EVENT = "wsp:workspace-look";

export interface WorkspaceLookRequest {
  readonly workspaceId: string;
  readonly part: LookPart;
}

/** Asks for the picker of one fact of a workspace's look; the sidebar answers, since it draws the rows the pick shows on. */
export function requestWorkspaceLook(workspaceId: string, part: LookPart): void {
  window.dispatchEvent(new CustomEvent(WORKSPACE_LOOK_EVENT, { detail: { workspaceId, part } }));
}

export function onWorkspaceLookRequest(listener: (detail: WorkspaceLookRequest) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<WorkspaceLookRequest>).detail);
  window.addEventListener(WORKSPACE_LOOK_EVENT, handler);
  return () => window.removeEventListener(WORKSPACE_LOOK_EVENT, handler);
}

const PROJECT_TRIP_EVENT = "wsp:project-trip";

export interface ProjectTripRequest {
  readonly workspaceId: string;
  readonly trip: "import" | "export";
  /** The folder an import opens on and reads at once, as a drop on the workspace's row names it. */
  readonly source?: string;
}

/** Asks for a project trip's dialog, the import or the export; the sidebar answers with the one it owns. */
export function requestProjectTrip(detail: ProjectTripRequest): void {
  window.dispatchEvent(new CustomEvent(PROJECT_TRIP_EVENT, { detail }));
}

export function onProjectTripRequest(listener: (detail: ProjectTripRequest) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<ProjectTripRequest>).detail);
  window.addEventListener(PROJECT_TRIP_EVENT, handler);
  return () => window.removeEventListener(PROJECT_TRIP_EVENT, handler);
}

let composerFocusWanted: string | null = null;
const composerFocusListeners = new Set<(workspaceId: string) => void>();

export function requestComposerFocus(workspaceId: string): void {
  composerFocusWanted = workspaceId;
  for (const listener of [...composerFocusListeners]) listener(workspaceId);
}

/** Takes the pending focus for one workspace, whether it was asked for before or after that composer mounted. */
export function onComposerFocusRequest(workspaceId: string, listener: () => void): () => void {
  const take = (target: string): void => {
    if (target !== workspaceId || composerFocusWanted !== workspaceId) return;
    composerFocusWanted = null;
    listener();
  };
  composerFocusListeners.add(take);
  take(workspaceId);
  return () => composerFocusListeners.delete(take);
}
