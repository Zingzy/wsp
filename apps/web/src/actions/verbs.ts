// SPDX-License-Identifier: AGPL-3.0-only
// The verbs the registries call, bound to the stores once: every surface that
// resolves a registry takes these, and a surface with its own confirmation
// (the sidebar's forget dialog) puts its opener in place of the default.
import { useMemo } from "react";
import { useStore } from "../protocol/store.js";
import { useRightPanelStore } from "../rightPanelStore.js";
import { openNewThread } from "../shell/NewThreadPicks.js";
import { showTerminal } from "../shell/shellCommands.js";
import { requestDeleteWorkspace, requestForgetWorkspace, requestProjectTrip, requestRenameWorkspace, requestWorkspaceLook, requestUndoRewind } from "../shell/shellRequests.js";
import { copyText } from "./clipboard.js";
import type { ThreadVerbs } from "./threadActions.js";
import type { WorkspaceVerbs } from "./workspaceActions.js";

export function useWorkspaceVerbs(): WorkspaceVerbs {
  const api = useStore(s => s.api);
  const newThread = useStore(s => s.newThread);
  const bringBackWork = useStore(s => s.bringBack);
  const togglePhase = useStore(s => s.toggle);
  const openSurface = useRightPanelStore(s => s.open);
  const rebuild = api?.rebuild;
  const restartDaemon = api?.restartDaemon;
  const forget = api?.forget;
  const canDelete = api?.deleteWorkspace !== undefined;
  const canRename = api?.renameWorkspace !== undefined;
  const canLook = api?.setWorkspaceLook !== undefined;
  const canExport = api?.exportProject !== undefined;
  const canBringBack = api?.bringBack !== undefined;
  return useMemo<WorkspaceVerbs>(
    () => ({
      togglePhase,
      openTerminal: showTerminal,
      restartDaemon: restartDaemon === undefined ? undefined : async workspaceId => await restartDaemon(workspaceId),
      openBrowser: workspaceId => openSurface(workspaceId, "preview"),
      newThread: openNewThread,
      newThreadHere: newThread,
      bringBack: canBringBack ? bringBackWork : undefined,
      copyText,
      rebuild:
        rebuild === undefined
          ? undefined
          : async workspaceId => {
              await rebuild(workspaceId);
            },
      forget: forget === undefined ? undefined : requestForgetWorkspace,
      deleteWorkspace: canDelete ? requestDeleteWorkspace : undefined,
      rename: canRename ? requestRenameWorkspace : undefined,
      pickLook: canLook ? requestWorkspaceLook : undefined,
      exportProject: canExport ? workspaceId => requestProjectTrip({ workspaceId, trip: "export" }) : undefined,
    }),
    [bringBackWork, canBringBack, canDelete, canExport, canLook, canRename, forget, newThread, openSurface, rebuild, restartDaemon, togglePhase],
  );
}

export function useThreadVerbs(): ThreadVerbs {
  const api = useStore(s => s.api);
  const forgetThread = useStore(s => s.forgetThread);
  const settleThreads = useStore(s => s.settleThreads);
  const restoreThreads = useStore(s => s.restoreThreads);
  const markThreads = useStore(s => s.markThreads);
  const stop = api?.interruptSession;
  const canForget = api?.forgetThread !== undefined;
  const canSettle = api?.settleThreads !== undefined;
  const canRestore = api?.restoreThreads !== undefined;
  const canMark = api?.markThreads !== undefined;
  const canUndoRewind = api?.undoRewind !== undefined;
  return useMemo<ThreadVerbs>(
    () => ({
      stop:
        stop === undefined
          ? undefined
          : async sessionId => {
              await stop(sessionId);
            },
      forget: canForget ? thread => void forgetThread(thread) : undefined,
      settle: canSettle ? settleThreads : undefined,
      restore: canRestore ? restoreThreads : undefined,
      mark: canMark ? markThreads : undefined,
      undoRewind: canUndoRewind ? requestUndoRewind : undefined,
      readEvents: api === null ? undefined : workspaceId => api.sessionHistory(workspaceId),
      copyText,
    }),
    [api, canForget, canMark, canRestore, canSettle, canUndoRewind, forgetThread, markThreads, restoreThreads, settleThreads, stop],
  );
}
