// SPDX-License-Identifier: AGPL-3.0-only
import { HEAD_RESULT_CHARS, type SessionEvent } from "@wsp/protocol";

/** What a read of one thread asks for: the events under `before` (every one when absent), newest first, at most
 * `limit` of them and no more than `bytes` of UTF-8 JSON as `shape` leaves each, the comma after each counted.
 * `strict` holds even the newest event to the bytes, so a read can answer none; without it the newest always comes,
 * so a page back always moves. */
export interface ThreadRead {
  before?: number;
  limit: number;
  bytes: number;
  strict?: boolean;
  shape?: (e: SessionEvent) => SessionEvent;
}

/** The events read, oldest first; pos is the newest position the workspace's transcript has issued, and total how
 * many events of the thread it holds. */
export interface ThreadEvents {
  events: SessionEvent[];
  pos: number;
  total: number;
}

/** One thread's events out of a workspace's transcript: everything a thread's head and a history page read, so the
 * store under the transcript changes behind this and neither op notices. */
export interface TranscriptReader {
  read(workspaceId: string, threadId: string, o: ThreadRead): Promise<ThreadEvents>;
}

/** The read over a transcript held as one array in the order its positions were issued. The events answered are
 * copies, so a caller that changes one changes nothing the host holds. */
export function readThread(events: readonly SessionEvent[], threadId: string, o: ThreadRead): Omit<ThreadEvents, "pos"> {
  const picked: SessionEvent[] = [];
  let total = 0;
  let bytes = 0;
  let full = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.threadId !== threadId) continue;
    total++;
    if (full || (o.before !== undefined && (e.pos ?? 0) >= o.before)) continue;
    const shaped = o.shape?.(e) ?? { ...e };
    const size = Buffer.byteLength(JSON.stringify(shaped)) + 1;
    if (picked.length >= o.limit || ((o.strict === true || picked.length > 0) && bytes + size > o.bytes)) {
      full = true;
      continue;
    }
    picked.push(shaped);
    bytes += size;
  }
  return { events: picked.reverse(), total };
}

/** An event as a head carries it: a tool result past HEAD_RESULT_CHARS cut there and marked with its whole length. */
export const headShape = (e: SessionEvent): SessionEvent =>
  e.type === "session.delta" && e.kind === "tool_result" && e.text.length > HEAD_RESULT_CHARS ? { ...e, text: e.text.slice(0, HEAD_RESULT_CHARS), cut: e.text.length } : { ...e };
