// SPDX-License-Identifier: AGPL-3.0-only
// The port every harness adapter is written against: the process a turn runs
// in (ExecStream, whatever launched it) and the events an adapter normalizes
// its CLI's output into (AdapterEvent). It sits here, beside the wire types,
// so no adapter owns the interface its siblings implement. The runtime folds
// these into the SessionEvent shapes in index.ts that clients read, which is
// why the vocabulary they share (DeltaKind, TurnResult, SessionHarness) is
// declared once there and imported back here.
import type { DeltaKind, SessionHarness, TurnResult } from "./index.js";

export type AdapterEvent =
  | {
      type: "session.start";
      sessionId: string;
      model?: string;
      cwd?: string;
      tools?: string[];
      harness?: SessionHarness;
    }
  | {
      type: "turn.delta";
      sessionId: string;
      kind: DeltaKind;
      text: string;
      toolName?: string;
      toolUseId?: string;
      isError?: boolean;
      /** The agent's tool shell folder after this tool_use, present only when the call moved it. */
      cwd?: string;
    }
  | { type: "turn.done"; sessionId: string; result: TurnResult }
  | { type: "session.end"; sessionId: string; exitCode: number | null; sawResult: boolean };

export interface ExecStream {
  readonly lines: AsyncIterable<string>;
  /** Graceful stop: SIGTERM. */
  teardown(): void;
  /** SIGKILL. */
  kill(): void;
  /** Appends one line to the process's stdin channel, or answers gone when the process already ended where it runs;
   * rejects once the stream ended or when it was started without one. */
  write(line: string): Promise<"written" | "gone">;
  /** Ends the stdin channel: the process reads EOF. Nothing after the stream ended. */
  closeInput(): void;
  readonly exited: Promise<number | null>;
}

export type ExecStreamFactory = (
  command: string,
  options: {
    env: Record<string, string>;
    /** Present, the process's stdin is a line channel seeded with these lines; absent, the process gets no channel. */
    input?: readonly string[];
  },
) => ExecStream;

/**
 * Reads what the harness itself calls one of its sessions, from the harness's own store on the machine: the title
 * it generated, overridden by whatever the person renamed the session to inside the harness. The id is the session
 * as that harness keys it, in whatever word it uses for one (Claude Code's session id, Codex's thread id). One
 * shell line goes to `exec` and its stdout is the answer. Null when the store keeps no title for that id, and when
 * it holds no such session at all; absent on an adapter whose harness keeps no title.
 */
export type SessionTitleReader = (harnessSessionId: string, exec: (command: string) => Promise<string>) => Promise<string | null>;

/**
 * Writes the name a person gave one of the harness's sessions into the harness's own store on the machine, the same
 * field the harness writes when the person renames the session inside it, so the harness itself shows the new name
 * too. The id is the session as that harness keys it, as SessionTitleReader takes it, and one shell line goes to
 * `exec`. written: the store took the name. no-session: nothing was written, because the store holds no such session
 * or the machine carries no such store at all. Absent on an adapter whose harness keeps no name of a person's.
 */
export type SessionRenamer = (harnessSessionId: string, title: string, exec: (command: string) => Promise<string>) => Promise<"written" | "no-session">;
