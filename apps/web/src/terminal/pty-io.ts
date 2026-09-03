// SPDX-License-Identifier: AGPL-3.0-only
// One pty as the terminal viewport sees it: bytes in through attach, keys out
// through write, resize straight through. The line-mode compose table sits
// between keys and the pty so a line-mode shell keeps local echo; its state
// lives here rather than in React because a keystroke must not re-render.
import { composeKey, composeMode, RAW_STATE, type ComposeState, type ComposeStep } from "./compose.js";
import type { WorkspaceTerminals } from "./link.js";

/** What the viewport exposes of its surface: paint bytes, or wipe for a replay. */
export interface TerminalScreen {
  write(data: string): void;
  reset(): void;
}

export interface TerminalIo {
  /** Replays the pty's scrollback into screen, then streams live bytes; returns detach. */
  attach(screen: TerminalScreen): () => void;
  /** A keystroke or paste from the surface. */
  write(data: string): void;
  resize(cols: number, rows: number): void;
}

export function composedPtyIo(wt: WorkspaceTerminals, ptyId: string): TerminalIo {
  let compose: ComposeState = RAW_STATE;
  let screen: TerminalScreen | null = null;
  const apply = (step: ComposeStep): void => {
    compose = step.state;
    if (step.toScreen) screen?.write(step.toScreen);
    if (step.toPty) wt.write(ptyId, step.toPty);
  };
  return {
    attach(next) {
      screen = next;
      const unbind = wt.bind(ptyId, {
        data: d => next.write(d),
        reset: () => {
          // The screen is wiped and the mode is unknown until re-attach reports it.
          compose = RAW_STATE;
          next.reset();
        },
        mode: report => apply(composeMode(compose, report)),
      });
      return () => {
        unbind();
        if (screen === next) screen = null;
      };
    },
    write: key => apply(composeKey(compose, key)),
    resize: (cols, rows) => wt.resize(ptyId, cols, rows),
  };
}
