// SPDX-License-Identifier: AGPL-3.0-only
// The port every harness adapter is written against: the process a turn runs
// in (ExecStream, whatever launched it), the events an adapter normalizes its
// CLI's output into (AdapterEvent), what it reads off its binary when the
// runtime asks what that binary takes (HarnessCatalogAnswer), and what it
// reads out of the harness's own store when the runtime asks what that harness
// calls a session (SessionTitleReader). It sits here, beside the wire types,
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

/** One model as an adapter reads it off its binary: the values the CLI takes, without the words the runtime's table
 * lends them. contextWindows carries both windows where the CLI offers the model at two, else none. */
export interface HarnessCatalogModelProbe {
  slug: string;
  label: string;
  description?: string;
  /** The effort values this model takes: absent where the binary does not say and every effort stays open, empty
   * where it says the model takes none. The two are different answers and the composer draws them differently. */
  efforts?: readonly string[];
  /** The effort this model runs at when a turn names none, where the binary reports one. */
  defaultEffort?: string;
  contextWindows: readonly string[];
  isDefault: boolean;
}

/** What an adapter reads off its binary on the workspace's machine: the lists the CLI itself reports. */
export interface HarnessCatalogProbe {
  version: string | null;
  models: readonly HarnessCatalogModelProbe[];
  efforts: readonly string[];
  permissionModes: readonly string[];
}

/** What an adapter answers when its binary ran and described no models for a reason it can name (no sign-in): the
 * runtime's table stands, and the composer's footer says these words in place of naming the binary as silent. */
export interface HarnessCatalogRefusal {
  refused: string;
}

/** The three things asking a binary about itself can come back with: its lists, its named reason for having none,
 * or nothing at all. */
export type HarnessCatalogAnswer = HarnessCatalogProbe | HarnessCatalogRefusal | null;

/** A refusal, not lists: an answer that named why the binary described nothing. */
export function catalogRefused(answer: HarnessCatalogAnswer): answer is HarnessCatalogRefusal {
  return answer !== null && "refused" in answer;
}

/**
 * Reads what the harness itself calls one of its sessions, from the harness's own store on the machine: the title
 * it generated, overridden by whatever the person renamed the session to inside the harness. The id is the session
 * as that harness keys it, in whatever word it uses for one (Claude Code's session id, Codex's thread id). One
 * shell line goes to `exec` and its stdout is the answer. Null when the store keeps no title for that id, and when
 * it holds no such session at all; absent on an adapter whose harness keeps no title.
 */
export type SessionTitleReader = (harnessSessionId: string, exec: (command: string) => Promise<string>) => Promise<string | null>;

/**
 * What a rename came to in the harness's own store. written: the store took the name. no-session: the store answered
 * and holds no such session, so there was nothing to name. failed: the store was there and the write did not land,
 * and `error` is the line the machine gave for it (the store's own message, a lock that never came free, no store on
 * the machine at all); nothing may be told about a session from it.
 */
export type SessionRenameWrite = { kind: "written" } | { kind: "no-session" } | { kind: "failed"; error: string };

/**
 * Writes the name a person gave one of the harness's sessions into the harness's own store on the machine, the same
 * field the harness writes when the person renames the session inside it, so the harness itself shows the new name
 * too. The id is the session as that harness keys it, as SessionTitleReader takes it, and one shell line goes to
 * `exec`, whose stdout says which of the three answers it is. Absent on an adapter whose harness keeps no name of a
 * person's.
 */
export type SessionRenamer = (harnessSessionId: string, title: string, exec: (command: string) => Promise<string>) => Promise<SessionRenameWrite>;
