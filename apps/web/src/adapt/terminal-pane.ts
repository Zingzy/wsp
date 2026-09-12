// SPDX-License-Identifier: AGPL-3.0-only
// What a terminal pane says over its frozen frame, from the workspace's state
// (the one vocabulary), the daemon reach and the pane's own socket. A pty
// survives a pause (the machine is frozen, not rebuilt), so a paused pane keeps
// its frame and offers the wake; only a replaced machine loses the shell.
import { biggerSizeLine, outOfMemoryLine, type DaemonLinkStatus, type MachineSizeOffer, type MemoryReading, type ReachState, type WorkspaceSize, type WorkspaceState } from "@wsp/protocol";

export type TerminalPaneState =
  | { readonly kind: "live" }
  /** The machine runs and the pane is dialling its daemon: a fresh link, a drop, or a reach the runtime calls unreachable. */
  | { readonly kind: "reconnecting"; readonly outOfMemory?: MemoryReading }
  /** The workspace refused the token the host opened the connection with; the host dials again with the one it
   * holds now. No token of this window's is involved: it holds none. */
  | { readonly kind: "reauth" }
  /** What the workspace runs on turned this window's connection away with a status, so it never opened and no retry
   * at the usual pace would open one. reason is that answer in its own words, empty when it sent none. */
  | { readonly kind: "refused"; readonly reason: string }
  /** The runtime's reach tracker spent its budget: the provider says running, the guest answers nothing. */
  | { readonly kind: "not-answering"; readonly outOfMemory?: MemoryReading }
  /** There is no daemon on this machine to dial: the host wired none for its kind, or the machine carries no route
   * to one. Nothing is reconnecting, so the pane says the daemon is absent instead of promising it back. */
  | { readonly kind: "no-daemon" }
  | { readonly kind: "paused"; readonly pausing: boolean }
  | { readonly kind: "waking" }
  | { readonly kind: "gone" };

export interface TerminalPaneInput {
  readonly state: WorkspaceState;
  readonly reach: ReachState | null;
  readonly socket: DaemonLinkStatus;
  /** What turned the connection away, in its own words, while the socket reads refused. */
  readonly refusal?: string | null;
  /** The daemon's last reading before its link went, when memory was near full; the pane then says what took the machine. */
  readonly outOfMemory?: MemoryReading | null;
}

export function terminalPaneState(input: TerminalPaneInput): TerminalPaneState {
  const oom = input.outOfMemory ? { outOfMemory: input.outOfMemory } : {};
  switch (input.state) {
    case "gone":
      return { kind: "gone" };
    case "pausing":
      return { kind: "paused", pausing: true };
    case "paused":
      return { kind: "paused", pausing: false };
    case "waking":
      return { kind: "waking" };
    case "unreachable":
      return input.reach === "zombie" ? { kind: "not-answering", ...oom } : { kind: "reconnecting", ...oom };
    case "running":
      if (input.socket === "live") return { kind: "live" };
      if (input.socket === "refused") return { kind: "refused", reason: input.refusal ?? "" };
      // The runtime says this machine has no daemon road at all, so no amount of dialling would open a terminal.
      if (input.reach === "unsupported") return { kind: "no-daemon" };
      return input.socket === "reauth-needed" ? { kind: "reauth" } : { kind: "reconnecting", ...oom };
    default: {
      const _exhaustive: never = input.state;
      return { kind: "live" };
    }
  }
}

/** The one line a pane shows for its state; null while live. */
export function terminalPaneTitle(pane: TerminalPaneState): string | null {
  switch (pane.kind) {
    case "live":
      return null;
    case "reconnecting":
      return "Reconnecting to the workspace";
    case "reauth":
      return "The workspace refused a stale daemon token; reconnecting with the one wsp holds now";
    case "not-answering":
      return pane.outOfMemory ? outOfMemoryLine(pane.outOfMemory) : "The workspace is not answering";
    case "no-daemon":
      return NO_DAEMON_TITLE;
    case "refused":
      return REFUSED_TITLE;
    case "paused":
      return `${pane.pausing ? "Pausing" : "Paused"}. The shell is kept; wake the workspace to continue`;
    case "waking":
      return "Waking the workspace. The shell continues when it is back";
    case "gone":
      return "The workspace is gone";
    default: {
      const _exhaustive: never = pane;
      return null;
    }
  }
}

const REBUILD_HINT = "Rebuild it from the Workspace panel";

/** What a shell says when the computer under it went: the pane's overlay and the bytes written into the terminal
 * itself read one sentence, so a person who saw it in the scrollback and a person who saw the overlay read the
 * same thing. */
export const SHELL_ENDED_LINE = "This shell ended when the workspace moved to another computer";

/** What a pane says for a machine with no daemon at all. One sentence stating the fact, with no return promised and
 * nothing to wait for: a pane that read "reconnecting" for a workspace that never had a daemon road was the bug
 * (seen on a local workspace before its daemon landed).  */
const NO_DAEMON_TITLE = "There is no daemon on this workspace";
const NO_DAEMON_LINE = "There is no daemon on this workspace, so no terminal opens here";
const NO_DAEMON_TYPING = "Typing is refused: there is no daemon on this workspace";

/** What a pane says for a connection that was turned away. The fact of what happened to this window's connection,
 * then that the work on the workspace is untouched by it, with no return promised and nothing offered to do: the
 * retry that goes on behind it is at the slowest pace there is. Neither sentence says machine or daemon, which a
 * person never reads, and a test pins the words. */
const REFUSED_TITLE = "The connection to this workspace was refused; its threads keep running";
const REFUSED_TYPING = "Typing is refused: the connection to this workspace was refused";

/** The lines under the pane's title, in the order they are shown. A drop with memory near full says so and names
 * the next size up before anything else; the rebuild is the last thing offered, and only once the runtime gave up
 * on the machine or the provider lost it. The size line needs the machine's size and the provider's table, which
 * a pane may not have yet. */
export function terminalPaneHints(pane: TerminalPaneState, size: WorkspaceSize | null, sizes: readonly MachineSizeOffer[] | null): string[] {
  const bigger = size !== null && sizes !== null ? [biggerSizeLine(size, sizes)] : [];
  switch (pane.kind) {
    case "reconnecting":
      return pane.outOfMemory ? [outOfMemoryLine(pane.outOfMemory), ...bigger] : [];
    case "not-answering":
      return pane.outOfMemory ? [...bigger, REBUILD_HINT] : [REBUILD_HINT];
    case "no-daemon":
    case "refused":
      return [];
    case "gone":
      return [REBUILD_HINT];
    case "live":
    case "reauth":
    case "paused":
    case "waking":
      return [];
    default: {
      const _exhaustive: never = pane;
      return [];
    }
  }
}

/** What an empty pane says instead of offering a terminal; null while live. */
export function terminalEmptyLine(pane: TerminalPaneState): string | null {
  switch (pane.kind) {
    case "live":
      return null;
    case "reconnecting":
      return "The daemon link is reconnecting; terminals open when it is back";
    case "reauth":
      return "The workspace refused a stale daemon token; terminals open once the link carries the current one";
    case "not-answering":
      return "The workspace is not answering; terminals open when it does";
    case "no-daemon":
      return NO_DAEMON_LINE;
    case "refused":
      return `No terminal opens from this window: ${pane.reason}. The workspace's threads keep running.`;
    case "paused":
      return `Workspace is ${pane.pausing ? "pausing" : "paused"}; wake it to open a terminal`;
    case "waking":
      return "Workspace is waking; terminals open when it is running";
    case "gone":
      return "The workspace is gone; rebuild it from the Workspace panel";
    default: {
      const _exhaustive: never = pane;
      return null;
    }
  }
}

/** Why a keystroke is not sent; null while live. */
export function terminalInputRefusal(pane: TerminalPaneState): string | null {
  switch (pane.kind) {
    case "live":
      return null;
    case "reconnecting":
      return "Typing is refused while the workspace is reconnecting";
    case "reauth":
      return "Typing is refused until the workspace takes the current daemon token";
    case "not-answering":
      return "Typing is refused: the workspace is not answering";
    case "no-daemon":
      return NO_DAEMON_TYPING;
    case "refused":
      return REFUSED_TYPING;
    case "paused":
      return `Typing is refused: the workspace is ${pane.pausing ? "pausing" : "paused"}`;
    case "waking":
      return "Typing is refused while the workspace wakes";
    case "gone":
      return "Typing is refused: the workspace is gone";
    default: {
      const _exhaustive: never = pane;
      return null;
    }
  }
}
