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
  /** The daemon refused the token this tab dialled with; the link is asking wsp for the current one. */
  | { readonly kind: "reauth" }
  /** The runtime's reach tracker spent its budget: the provider says running, the guest answers nothing. */
  | { readonly kind: "not-answering"; readonly outOfMemory?: MemoryReading }
  | { readonly kind: "paused"; readonly pausing: boolean }
  | { readonly kind: "waking" }
  | { readonly kind: "gone" };

export interface TerminalPaneInput {
  readonly state: WorkspaceState;
  readonly reach: ReachState | null;
  readonly socket: DaemonLinkStatus;
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
      return "Reconnecting to the machine";
    case "reauth":
      return "The machine refused a stale daemon token; reconnecting with the one wsp holds now";
    case "not-answering":
      return pane.outOfMemory ? outOfMemoryLine(pane.outOfMemory) : "The machine is not answering";
    case "paused":
      return `${pane.pausing ? "Pausing" : "Paused"}. The shell is kept; wake the workspace to continue`;
    case "waking":
      return "Waking the machine. The shell continues when it is back";
    case "gone":
      return "The machine is gone";
    default: {
      const _exhaustive: never = pane;
      return null;
    }
  }
}

const REBUILD_HINT = "Rebuild it from the Machine panel";

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
      return "The machine refused a stale daemon token; terminals open once the link carries the current one";
    case "not-answering":
      return "The machine is not answering; terminals open when it does";
    case "paused":
      return `Workspace is ${pane.pausing ? "pausing" : "paused"}; wake it to open a terminal`;
    case "waking":
      return "Workspace is waking; terminals open when it is running";
    case "gone":
      return "The machine is gone; rebuild it from the Machine panel";
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
      return "Typing is refused while the machine is reconnecting";
    case "reauth":
      return "Typing is refused until the machine takes the current daemon token";
    case "not-answering":
      return "Typing is refused: the machine is not answering";
    case "paused":
      return `Typing is refused: the workspace is ${pane.pausing ? "pausing" : "paused"}`;
    case "waking":
      return "Typing is refused while the machine wakes";
    case "gone":
      return "Typing is refused: the machine is gone";
    default: {
      const _exhaustive: never = pane;
      return null;
    }
  }
}
