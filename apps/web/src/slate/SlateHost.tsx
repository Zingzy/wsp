// SPDX-License-Identifier: AGPL-3.0-only
// What ties the window's slates to the rest of the app, mounted once in the shell: the roads the slate store takes
// (the api, the selection, the right panel, the composer), and the first showing of a thread's slate when the person
// opens a thread whose agent wrote one while it was not on screen.
import { useEffect } from "react";
import { insertIntoComposer } from "../components/chat/composerInsert.js";
import { selectedWorkspaceIdOf, threadWorkspaceIn, useSelectedThreadId, useStore } from "../protocol/store.js";
import { isOpenable, useRightPanelStore } from "../rightPanelStore.js";
import { PANE_KINDS, type RightPanelKind } from "../panes.js";
import { workspaceOrHere } from "../terminal/computer.js";
import { bindSlates, loadSlate, showOnce } from "./store.js";

/** The workspace a thread's rows live under, where its composer keeps its draft. */
export const threadWorkspace = (threadId: string): string | null => threadWorkspaceIn(useStore.getState().sessions, threadId);

const isKind = (kind: string): kind is RightPanelKind => (PANE_KINDS as readonly string[]).includes(kind);

bindSlates({
  api: () => useStore.getState().api?.slates ?? null,
  selected: () => {
    const s = useStore.getState();
    return { threadId: s.settingsOpen ? null : s.selectedThreadId, panelKey: workspaceOrHere(selectedWorkspaceIdOf(s)) };
  },
  openPane: (panelKey, kind) => {
    if (!isKind(kind) || !isOpenable(kind)) return false;
    useRightPanelStore.getState().open(panelKey, kind);
    return true;
  },
  fill: (threadId, text) => {
    const workspaceId = threadWorkspace(threadId);
    if (workspaceId !== null) insertIntoComposer(workspaceId, text);
  },
});

export function SlateWatcher() {
  const threadId = useSelectedThreadId();
  const settingsOpen = useStore(s => s.settingsOpen);
  useEffect(() => {
    if (threadId === null || settingsOpen) return;
    void loadSlate(threadId).then(entry => showOnce(threadId, entry));
  }, [threadId, settingsOpen]);
  return null;
}
