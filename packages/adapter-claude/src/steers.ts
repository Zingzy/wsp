// SPDX-License-Identifier: AGPL-3.0-only
// The messages steered into a running turn, as the CLI reports what it does with each. A CLI that declares
// msg_lifecycle_v1 at init reports a message written with a uuid as it queues it, starts it and completes or cancels
// it, under that uuid (command_lifecycle, measured on 2.1.280). One that lands while the agent writes its last words
// is started only after the result, as a turn of the CLI's own, so a reply that came first is not yet the turn's.

import type { AdapterEvent } from "@wsp/protocol";
import { rec, str, strArr } from "./fields.js";

export interface Steers {
  /** The CLI reports what it does with each message; one that does not says nothing about what it took. */
  readonly reports: boolean;
  /** The CLI's interrupt cancels its queued messages when asked to. */
  readonly cancelsQueued: boolean;
  /** A message about to be written under its id, counted before the write: the CLI reports it queued the moment it
   * reads it. */
  add(uuid: string): void;
  /** A message whose write did not land. */
  forget(uuid: string): void;
  /** Takes a command_lifecycle line; false for any other line, the init among them, whose capabilities say what the
   * CLI does. */
  read(event: Record<string, unknown>): boolean;
  /** A message is still the CLI's to answer. */
  readonly open: boolean;
  /** A message is taken up and not finished: the CLI is at work on it, which a slash command like /compact does
   * with nothing printed for as long as it takes. */
  readonly working: boolean;
  /** Fixes the messages never taken up as the turn's reply goes out: one the CLI starts after it is answered to nobody.
   * True where one of them is still in the CLI's queue. */
  settle(): boolean;
  /** Tells those messages' ids as turn.unread, once, and none after; none where the CLI never reported one, which
   * says nothing. */
  tellUnread(sessionId: string, onEvent: (event: AdapterEvent) => void): void;
}

/** The steers of one turn, starting from the messages its run's channel already took on a turn re-opened after a host
 * restart. */
export function steersOf(taken: readonly string[]): Steers {
  const steers = new Map<string, { started: boolean }>(steeredIds(taken).map(uuid => [uuid, { started: false }]));
  const dropped: string[] = [];
  let reports = false;
  let cancelsQueued = false;
  let fixed: string[] | undefined;
  let told = false;
  const notStarted = (): string[] => [...steers].flatMap(([id, steer]) => (steer.started ? [] : [id]));
  return {
    get reports() {
      return reports;
    },
    get cancelsQueued() {
      return cancelsQueued;
    },
    add: uuid => void steers.set(uuid, { started: false }),
    forget: uuid => void steers.delete(uuid),
    read: event => {
      if (str(event.type) === "system" && str(event.subtype) === "init") {
        const capabilities = strArr(event.capabilities) ?? [];
        reports ||= capabilities.includes("msg_lifecycle_v1");
        cancelsQueued ||= capabilities.includes("interrupt_cancel_queued_v1");
      }
      if (str(event.type) !== "command_lifecycle") return false;
      reports = true;
      const uuid = str(event.command_uuid);
      const steer = uuid === undefined ? undefined : steers.get(uuid);
      const state = str(event.state);
      if (steer === undefined || state === "queued") return true;
      if (state === "started") steer.started = true;
      else {
        steers.delete(uuid!);
        if (!steer.started) dropped.push(uuid!);
      }
      return true;
    },
    get open() {
      return reports && steers.size > 0;
    },
    get working() {
      return [...steers.values()].some(steer => steer.started);
    },
    settle: () => {
      fixed ??= reports ? [...dropped, ...notStarted()] : [];
      return reports && notStarted().length > 0;
    },
    tellUnread: (sessionId, onEvent) => {
      const ids = told ? [] : (fixed ?? (reports ? [...dropped, ...notStarted()] : []));
      told = true;
      if (ids.length > 0) onEvent({ type: "turn.unread", sessionId, ids });
    },
  };
}

/** The ids of the messages steered into the turn a run's channel holds last, off the lines it took: the ones carrying
 * a uuid after the last one carrying none, which is that turn's own opening on a process that served earlier turns.
 * Ids alone: the agent can write that file, so its words are never what goes back. */
export function steeredIds(taken: readonly string[]): string[] {
  const ids: string[] = [];
  for (const line of taken) {
    let message: Record<string, unknown> | undefined;
    try {
      message = rec(JSON.parse(line));
    } catch {
      continue;
    }
    if (message?.["type"] !== "user") continue;
    const uuid = str(message["uuid"]);
    if (uuid === undefined) ids.length = 0;
    else if (!ids.includes(uuid)) ids.push(uuid);
  }
  return ids;
}
