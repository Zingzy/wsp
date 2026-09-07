// SPDX-License-Identifier: AGPL-3.0-only
// Requests the palette, the shortcuts and the action registries raise for
// another region to fulfil, as window events so the raiser does not own that
// region's state. The sidebar answers new-workspace and forget-workspace with
// its dialogs; new-thread waits for a chat container to subscribe. Composer
// focus is held rather than broadcast: the workspace switch selects and asks
// in one handler, and the composer it names remounts after that handler
// returns.
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
