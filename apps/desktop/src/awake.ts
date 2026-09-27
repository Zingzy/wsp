// SPDX-License-Identifier: AGPL-3.0-only
// Whether the computer the app runs on is kept from sleeping on its own. Only
// a thread working on this computer's own workspaces counts: one on a box runs
// whether this computer sleeps or not, and one stopped on a prompt is waiting
// on the person, not working. The switch in Settings turns it off.
import { foldThreads, isLocalWorkspace, threadState, type SessionView, type WorkspaceView } from "@wsp/protocol";

export function awakeWanted(sessions: readonly SessionView[], workspaces: readonly WorkspaceView[], keepAwake: boolean): boolean {
  if (!keepAwake) return false;
  const here = new Set(workspaces.filter(isLocalWorkspace).map(w => w.id));
  return foldThreads(sessions).some(thread => here.has(thread.workspaceId) && threadState(thread) === "running");
}
