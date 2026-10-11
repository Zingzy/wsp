// SPDX-License-Identifier: AGPL-3.0-only
import type { AccessChoice, Caller, SessionStartResult, SessionView } from "@wsp/protocol";
import type { Runtime } from "../types/api.js";
import type { SessionHandle } from "../types/wiring.js";

type OnHeld = (held: { view: SessionView; turnId: string }) => void;

/** A sessions.start as the socket answers it. One that asked to hear of its hold is answered the moment its computer's
 * threads at once holds it back, with outcome held, and goes on to its launch unheard: what fails it from there reaches
 * its followers as the turn's end. Any other is answered once its turn starts, and a failure before then is its own. */
export async function answeredStart(answerHeld: boolean, start: (onHeld?: OnHeld) => Promise<SessionHandle>, answer: (reply: SessionStartResult) => void): Promise<void> {
  let answered = false;
  const onHeld: OnHeld = ({ view, turnId }) => {
    answered = true;
    answer({ session: view, outcome: "held", turnId });
  };
  const handle = await start(answerHeld ? onHeld : undefined).catch((e: unknown) => {
    if (!answered) throw e;
  });
  if (!answered && handle !== undefined) answer({ session: handle.view(), outcome: handle.outcome, turnId: handle.turnId });
}

/** Where a sessions.start or a sessions.warm runs: the record it names, else, on this computer, the folder of the
 * project, branch or folder it names, found or made, with the agent and picks it names read against that project. */
export async function startAt(
  workspaces: Pick<Runtime["workspaces"], "folderFor">,
  msg: { workspaceId?: string; project?: string; branch?: string; cwd?: string; harness?: string; model?: string; effort?: string; access?: AccessChoice; permissionMode?: string; fast?: boolean },
  origin: Caller | undefined,
): Promise<{ workspaceId: string; cwd?: string }> {
  if (msg.workspaceId !== undefined) return { workspaceId: msg.workspaceId, ...(msg.cwd !== undefined ? { cwd: msg.cwd } : {}) };
  const picks = {
    ...(msg.harness !== undefined ? { harness: msg.harness } : {}),
    ...(msg.model !== undefined ? { model: msg.model } : {}),
    ...(msg.effort !== undefined ? { effort: msg.effort } : {}),
    ...(msg.access !== undefined ? { access: msg.access } : {}),
    ...(msg.permissionMode !== undefined ? { permissionMode: msg.permissionMode } : {}),
    ...(msg.fast === true ? { fast: true } : {}),
  };
  const found = await workspaces.folderFor(
    {
      ...(msg.project !== undefined ? { project: msg.project } : {}),
      ...(msg.branch !== undefined ? { branch: msg.branch } : {}),
      ...(msg.cwd !== undefined ? { cwd: msg.cwd } : {}),
      ...(Object.keys(picks).length > 0 ? { picks } : {}),
    },
    origin,
  );
  return { workspaceId: found.workspace.id, ...(found.cwd !== undefined ? { cwd: found.cwd } : {}) };
}
