// SPDX-License-Identifier: AGPL-3.0-only
// The drawer under the chat, bound to the workspace's daemon link: ptys come
// from WorkspaceTerminals, their arrangement from the drawer store, and each
// viewport gets its io from the link. Opening the drawer on a workspace that
// never had a pty spawns one; closing the last never respawns.
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useTerminalIo } from "../hooks/useTerminalIo.js";
import { selectTerminalUiState, useTerminalDrawerStore } from "../terminal/drawerStore.js";
import type { TerminalUiState } from "../terminal/groups.js";
import { getTerminals, onTerminals, type PtyTabView, type WorkspaceTerminals } from "../terminal/link.js";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer.js";

export function terminalLabels(tabs: readonly PtyTabView[]): ReadonlyMap<string, string> {
  return new Map(tabs.map(t => [t.ptyId, t.exited ? `${t.title} (exited)` : t.title]));
}

export function WorkspaceTerminalDrawer({ workspaceId }: { workspaceId: string }) {
  const terms = useSyncExternalStore(onTerminals, () => getTerminals(workspaceId));
  const ui = useTerminalDrawerStore(s => selectTerminalUiState(s.byWorkspaceId, workspaceId));
  if (!terms || !ui.terminalOpen) return null;
  return <LinkedDrawer terms={terms} workspaceId={workspaceId} ui={ui} />;
}

function LinkedDrawer({ terms, workspaceId, ui }: { terms: WorkspaceTerminals; workspaceId: string; ui: TerminalUiState }) {
  const tabs = useSyncExternalStore(fn => terms.onTabs(fn), () => terms.tabs());
  const status = useSyncExternalStore(fn => terms.onStatus(fn), () => terms.status());
  const ids = useMemo(() => tabs.map(t => t.ptyId), [tabs]);
  const labels = useMemo(() => terminalLabels(tabs), [tabs]);
  const terminalIo = useTerminalIo(terms, ids);
  const store = useTerminalDrawerStore;

  useEffect(() => {
    store.getState().reconcile(workspaceId, ids);
  }, [store, workspaceId, ids]);

  const openNew = useCallback(
    () => terms.open().then(t => store.getState().add(workspaceId, t.ptyId)).catch(() => {}),
    [terms, store, workspaceId],
  );
  const split = useCallback(
    (direction: "horizontal" | "vertical") =>
      terms.open().then(t => store.getState().split(workspaceId, t.ptyId, direction)).catch(() => {}),
    [terms, store, workspaceId],
  );

  useEffect(() => {
    if (status === "live" && tabs.length === 0 && !terms.everOpened()) void openNew();
  }, [terms, status, tabs.length, openNew]);

  return (
    <ThreadTerminalDrawer
      workspaceId={workspaceId}
      height={ui.terminalHeight}
      terminalIds={ui.terminalIds}
      activeTerminalId={ui.activeTerminalId}
      terminalGroups={ui.terminalGroups}
      activeTerminalGroupId={ui.activeTerminalGroupId}
      focusRequestId={0}
      onSplitTerminal={() => void split("horizontal")}
      onSplitTerminalVertical={() => void split("vertical")}
      onNewTerminal={() => void openNew()}
      onActiveTerminalChange={id => {
        store.getState().activate(workspaceId, id);
        terms.setActive(id);
      }}
      onCloseTerminal={id => {
        store.getState().remove(workspaceId, id);
        void terms.close(id);
      }}
      onHeightChange={h => store.getState().setHeight(workspaceId, h)}
      terminalLabelsById={labels}
      terminalIo={terminalIo}
    />
  );
}
