// SPDX-License-Identifier: AGPL-3.0-only
// The verbs the registries call, bound to the stores once: every surface that
// resolves a registry takes these, and a surface with its own confirmation
// (the sidebar's forget dialog, the Machine tab's rebuild dialog) puts its
// opener in place of the default.
import { useMemo } from "react";
import { useStore } from "../protocol/store.js";
import { useRightPanelStore } from "../rightPanelStore.js";
import { showTerminal } from "../shell/shellCommands.js";
import { requestForgetWorkspace, requestNewThread, requestProjectTrip, requestRenameWorkspace, requestWorkspaceLook } from "../shell/shellRequests.js";
import { copyText } from "./clipboard.js";
import type { ThreadVerbs } from "./threadActions.js";
import type { WorkspaceVerbs } from "./workspaceActions.js";

export function useWorkspaceVerbs(): WorkspaceVerbs {
  const api = useStore(s => s.api);
  const select = useStore(s => s.select);
  const togglePhase = useStore(s => s.toggle);
  const openSurface = useRightPanelStore(s => s.open);
  const rebuild = api?.rebuild;
  const forget = api?.forget;
  const canRename = api?.renameWorkspace !== undefined;
  const canLook = api?.setWorkspaceLook !== undefined;
  const canImport = api?.planProject !== undefined && api.importProject !== undefined;
  const canExport = api?.exportProject !== undefined;
  return useMemo<WorkspaceVerbs>(
    () => ({
      togglePhase,
      openTerminal: showTerminal,
      openBrowser: workspaceId => openSurface(workspaceId, "preview"),
      openMachine: workspaceId => openSurface(workspaceId, "machine"),
      newThread: workspaceId => {
        select(workspaceId);
        requestNewThread({ workspaceId });
      },
      copyText,
      rebuild:
        rebuild === undefined
          ? undefined
          : async workspaceId => {
              await rebuild(workspaceId);
            },
      forget: forget === undefined ? undefined : requestForgetWorkspace,
      rename: canRename ? requestRenameWorkspace : undefined,
      pickLook: canLook ? requestWorkspaceLook : undefined,
      importProject: canImport ? workspaceId => requestProjectTrip({ workspaceId, trip: "import" }) : undefined,
      exportProject: canExport ? workspaceId => requestProjectTrip({ workspaceId, trip: "export" }) : undefined,
    }),
    [canExport, canImport, canLook, canRename, forget, openSurface, rebuild, select, togglePhase],
  );
}

export function useThreadVerbs(): ThreadVerbs {
  const api = useStore(s => s.api);
  const forgetThread = useStore(s => s.forgetThread);
  const stop = api?.interruptSession;
  const canForget = api?.forgetThread !== undefined;
  return useMemo<ThreadVerbs>(
    () => ({
      stop:
        stop === undefined
          ? undefined
          : async sessionId => {
              await stop(sessionId);
            },
      forget: canForget ? thread => void forgetThread(thread) : undefined,
      copyText,
    }),
    [canForget, forgetThread, stop],
  );
}
