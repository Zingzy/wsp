// SPDX-License-Identifier: AGPL-3.0-only
import type { RuntimeRequest } from "@wsp/protocol";
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
