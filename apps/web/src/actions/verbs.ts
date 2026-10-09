// SPDX-License-Identifier: AGPL-3.0-only
// The verbs the registries call, bound to the stores once: every surface that
// resolves a registry takes these, and a surface with its own confirmation
// (the sidebar's forget dialog) puts its opener in place of the default.
import { useMemo } from "react";
import { agentName } from "@wsp/catalog";
import { taskStopUnsupportedLine } from "@wsp/protocol";
import { addNotice, noticeFailure } from "../notices/store.js";
import type { Api } from "../protocol/client.js";
import { useStore } from "../protocol/store.js";
import { useRightPanelStore } from "../rightPanelStore.js";
import { openNewThread } from "../shell/NewThreadPicks.js";
import { showTerminal } from "../shell/shellCommands.js";
import { requestDeleteWorkspace, requestForgetWorkspace, requestProjectTrip, requestRenameWorkspace, requestUndoRewind } from "../shell/shellRequests.js";
import { copyText } from "./clipboard.js";
import { settleSaying, type ChildVerbs, type ThreadVerbs } from "./threadActions.js";
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
      exportProject: canExport ? workspaceId => requestProjectTrip({ workspaceId, trip: "export" }) : undefined,
    }),
    [bringBackWork, canBringBack, canDelete, canExport, canRename, forget, newThread, openSurface, rebuild, restartDaemon, togglePhase],
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
              const { left } = await stop(sessionId);
              if (left !== undefined) addNotice({ kind: "error", text: left });
            },
      forget: canForget ? thread => void forgetThread(thread) : undefined,
      settle: canSettle ? threadIds => settleSaying(threadIds, { settle: settleThreads, restore: restoreThreads }) : undefined,
      restore: canRestore ? restoreThreads : undefined,
      mark: canMark ? markThreads : undefined,
      undoRewind: canUndoRewind ? requestUndoRewind : undefined,
      readEvents: api === null ? undefined : workspaceId => api.sessionHistory(workspaceId),
      copyText,
    }),
    [api, canForget, canMark, canRestore, canSettle, canUndoRewind, forgetThread, markThreads, restoreThreads, settleThreads, stop],
  );
}

/** Stops one subagent of a turn: a refusal is a notice in the host's words, named by the subagent. The host words
 * every refusal; an agent with no stop of one subagent reads the host's own line where its words are missing. */
export async function stopSubagent(api: Pick<Api, "interruptSession">, task: { sessionId: string; task: string; harness: string; title: string }): Promise<void> {
  if (api.interruptSession === undefined) return;
  try {
    const { outcome, error } = await api.interruptSession(task.sessionId, task.task);
    if (outcome !== "refused" && outcome !== "unsupported") return;
    const text = error ?? (outcome === "unsupported" ? taskStopUnsupportedLine(agentName(task.harness)) : undefined);
    if (text !== undefined) addNotice({ kind: "error", text, where: task.title });
  } catch (e) {
    noticeFailure(e, said => said, { where: task.title });
  }
}

/** Sends a message to a thread as the composer would, a refusal said as a notice naming the thread. */
export function sendToThread(api: Pick<Api, "startSession"> | null, thread: { workspaceId: string; threadId: string | null; harness: string; title: string }, prompt: string): void {
  if (api === null) return;
  void api
    .startSession({ workspaceId: thread.workspaceId, prompt, harness: thread.harness, requestId: crypto.randomUUID(), ...(thread.threadId !== null ? { thread: thread.threadId } : {}) })
    .catch((e: unknown) => noticeFailure(e, said => said, { where: thread.title }));
}

/** The verbs a lead's child takes but its message field, which its row opens itself. */
export function useChildVerbs(): ChildVerbs {
  const api = useStore(s => s.api);
  const settle = useStore(s => s.settleThreads);
  const restore = useStore(s => s.restoreThreads);
  const stop = api?.interruptSession;
  const canSettle = api?.settleThreads !== undefined;
  const canRestore = api?.restoreThreads !== undefined;
  return useMemo<ChildVerbs>(
    () => ({
      stop:
        stop === undefined
          ? undefined
          : async sessionId => {
              const { left } = await stop(sessionId);
              if (left !== undefined) addNotice({ kind: "error", text: left });
            },
      stopTask: stop === undefined ? undefined : task => stopSubagent({ interruptSession: stop }, task),
      open: threadId => {
        const { sessions, select } = useStore.getState();
        const at = Object.entries(sessions).find(([, rows]) => rows.some(row => row.threadId === threadId))?.[0];
        if (at !== undefined) select(at, threadId);
      },
      settle: canSettle ? settle : undefined,
      restore: canRestore ? restore : undefined,
    }),
    [canRestore, canSettle, restore, settle, stop],
  );
}
