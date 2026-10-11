// SPDX-License-Identifier: AGPL-3.0-only
import { BRANCH_ON_A_THREAD_LINE, FORK_BESIDE_FIX, FORK_BESIDE_LINE, FORK_RESUME_FIX, FORK_RESUME_LINE, usageRefusal, type Caller, type RuntimeRequest, type SessionStartResult } from "@wsp/protocol";
import { answeredStart, startAt } from "./threads/answered-start.js";
import type { OutsideOpening, Runtime } from "./types/api.js";

type StartAsked = Extract<RuntimeRequest, { op: "sessions.start" }>;
type StartOptions = Parameters<Runtime["sessions"]["start"]>[1];

/** What sessions.start hands the runtime off the request: each field the client named, copied by hand so none rides
 * that the runtime does not take, in the folder the start was placed in and on the outside conversation it opens on. */
export function startOptionsOf(msg: StartAsked, at: { cwd?: string | undefined }, outside: OutsideOpening | undefined, held: Pick<StartOptions, "onHeld">): StartOptions {
  return {
    prompt: msg.prompt, ...held, ...(msg.followed === true ? { followed: true } : {}),
    ...(msg.harness !== undefined ? { harness: msg.harness } : {}),
    ...(msg.thread !== undefined ? { thread: msg.thread } : {}),
    ...(at.cwd !== undefined ? { cwd: at.cwd } : {}),
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
    ...(msg.replaces !== undefined ? { replaces: msg.replaces } : {}),
    ...(msg.attachments !== undefined ? { attachments: msg.attachments } : {}),
    ...(outside !== undefined ? { outside } : {}),
  };
}

/** A sessions.start off the socket: a fork in its source's folder, else a conversation kept outside wsp where it ran,
 * else the folder of the record, project, branch or folder it names, found or made first. */
export async function serveStart(rt: Pick<Runtime, "sessions" | "workspaces" | "conversations">, msg: StartAsked, origin: Caller | undefined, reply: (r: SessionStartResult) => void): Promise<void> {
  if (msg.workspaceId !== undefined && msg.branch !== undefined) throw Object.assign(new Error(BRANCH_ON_A_THREAD_LINE), { kind: "usage" });
  // A fork's folder is its source's, or a new worktree of the source's repo: nothing else may name one.
  if (msg.fork !== undefined && (msg.workspaceId !== undefined || msg.project !== undefined || msg.cwd !== undefined || msg.thread !== undefined || msg.replaces !== undefined)) throw usageRefusal(FORK_BESIDE_LINE, FORK_BESIDE_FIX);
  if (msg.fork !== undefined && msg.resume !== undefined) throw usageRefusal(FORK_RESUME_LINE, FORK_RESUME_FIX);
  const fork = msg.fork;
  if (fork !== undefined) {
    await answeredStart(msg.answerHeld === true, onHeld => rt.sessions.fork({ ...startOptionsOf(msg, {}, undefined, onHeld !== undefined ? { onHeld } : {}), fork, ...(msg.branch !== undefined ? { branch: msg.branch } : {}) }, origin), reply);
    return;
  }
  // A conversation the agent kept outside wsp says where its thread runs, so it is read before the folder is.
  const resumed = msg.resume === undefined ? undefined : await rt.conversations.placed(msg, msg.resume, origin);
  const at = resumed ?? (await startAt(rt.workspaces, msg, origin));
  await answeredStart(msg.answerHeld === true, onHeld => rt.sessions.start(at.workspaceId, startOptionsOf(msg, at, resumed?.outside, onHeld !== undefined ? { onHeld } : {}), origin), reply);
}
