// SPDX-License-Identifier: AGPL-3.0-only
import type { RuntimeRequest, SessionStartResult, SessionView } from "@wsp/protocol";
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

/** What a sessions.start asks of the thread it starts or forks, beside where it runs. */
export function startAsked(msg: Extract<RuntimeRequest, { op: "sessions.start" }>) {
  return {
    prompt: msg.prompt,
    ...(msg.followed === true ? { followed: true } : {}),
    ...(msg.harness !== undefined ? { harness: msg.harness } : {}),
    ...(msg.model !== undefined ? { model: msg.model } : {}),
    ...(msg.effort !== undefined ? { effort: msg.effort } : {}),
    ...(msg.permissionMode !== undefined ? { permissionMode: msg.permissionMode } : {}),
    ...(msg.access !== undefined ? { access: msg.access } : {}),
    ...(msg.contextWindow !== undefined ? { contextWindow: msg.contextWindow } : {}),
    ...(msg.fast !== undefined ? { fast: msg.fast } : {}),
    ...(msg.startedBy !== undefined ? { startedBy: msg.startedBy } : {}),
    ...(msg.requestId !== undefined ? { requestId: msg.requestId } : {}),
    ...(msg.attempt !== undefined ? { attempt: msg.attempt } : {}),
    ...(msg.notify !== undefined ? { notify: msg.notify } : {}),
    ...(msg.turnToken !== undefined ? { turnToken: msg.turnToken } : {}),
    ...(msg.title !== undefined ? { title: msg.title } : {}),
    ...(msg.attachments !== undefined ? { attachments: msg.attachments } : {}),
  };
}
