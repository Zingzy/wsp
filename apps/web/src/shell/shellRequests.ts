// SPDX-License-Identifier: AGPL-3.0-only
// Requests the palette and shortcuts raise for another region to fulfil, as
// window events so the raiser does not own that region's state. The sidebar
// answers new-workspace with its dialog; new-thread waits for a chat
// container to subscribe.
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
