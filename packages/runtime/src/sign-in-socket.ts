// SPDX-License-Identifier: AGPL-3.0-only
// One socket's side of the sign-ins: the runs it started, joined or followed
// off the list, which are the only ones it may type a code into or stop. A
// step a run pushes as the socket starts following it waits behind the answer,
// so the answer naming the run comes first. The socket's leaves run when it
// closes, which never ends a run.
import { noSignInRefusal, type AgentsSignInEvent, type Caller, type RuntimeRequest } from "@wsp/protocol";
import type { Runtime } from "./runtime.js";

type Send = (payload: Record<string, unknown>) => void;
type SignInOp = Extract<RuntimeRequest, { op: "agents.signIn" | "servers.signIn" | "agents.signIns" | "agents.signInCode" | "agents.signInStop" }>;

export function signInSocket(agents: Runtime["agents"], socket: { open(): boolean; detach(leave: () => void): void }): (msg: SignInOp, send: Send, origin: Caller | undefined) => Promise<void> {
  const signIns = new Set<string>();
  const heldBehindAnswer = (send: Send): { emit(event: AgentsSignInEvent): void; answer(payload: Record<string, unknown>): void } => {
    let queued: AgentsSignInEvent[] | null = [];
    return {
      emit: event => {
        if (queued !== null) queued.push(event);
        else if (socket.open()) send(event);
      },
      answer: payload => {
        send(payload);
        const held = queued ?? [];
        queued = null;
        for (const event of held) send(event);
      },
    };
  };
  return async (msg, send, origin) => {
    switch (msg.op) {
      case "agents.signIn":
      case "servers.signIn": {
        const held = heldBehindAnswer(send);
        const ask =
          msg.op === "servers.signIn"
            ? { agent: msg.agent, server: msg.name, ...(msg.scope !== undefined ? { scope: msg.scope } : {}), ...(msg.project !== undefined ? { project: msg.project } : {}) }
            : { agent: msg.agent, ...(msg.terminal === true ? { terminal: true } : {}) };
        const { signInId, leave } = await agents.signIn(msg.target, ask, held.emit, origin);
        if (signIns.has(signInId)) {
          leave();
          send({ id: msg.id, ok: true, signInId });
          return;
        }
        signIns.add(signInId);
        socket.detach(leave);
        if (!socket.open()) return leave();
        held.answer({ id: msg.id, ok: true, signInId });
        return;
      }
      case "agents.signIns": {
        const held = heldBehindAnswer(send);
        const runs = agents.signIns();
        for (const run of runs) {
          if (run.ended === true || signIns.has(run.signInId)) continue;
          signIns.add(run.signInId);
          socket.detach(agents.signInFollow(run.signInId, held.emit).leave);
        }
        held.answer({ id: msg.id, ok: true, runs });
        return;
      }
      default:
        if (!signIns.has(msg.signInId)) {
          send({ id: msg.id, ok: false, error: noSignInRefusal, kind: "usage" });
          return;
        }
        if (msg.op === "agents.signInCode") await agents.signInCode(msg.signInId, msg.code);
        else agents.signInStop(msg.signInId);
        send({ id: msg.id, ok: true });
    }
  };
}
