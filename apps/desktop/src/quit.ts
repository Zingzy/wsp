// SPDX-License-Identifier: AGPL-3.0-only
// The question a quit asks. wsp runs as this computer's own service, so
// quitting the app leaves every thread working; the second answer stops wsp
// too, and the turns on this computer before it, so nothing is left running
// with nobody reading it.
import { THIS_COMPUTER } from "@wsp/protocol";

export type QuitChoice = "quit" | "stop" | "cancel";

/** The menu row that asks. */
export const QUIT_WORD = "Quit wsp";

const CHOICES: readonly { choice: QuitChoice; label: string }[] = [
  { choice: "quit", label: "Quit" },
  { choice: "stop", label: "Quit and stop wsp" },
  { choice: "cancel", label: "Cancel" },
];

export interface QuitPrompt {
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
}

/** The dialog for a quit while `working` turns run on this computer's workspaces. */
export function quitPrompt(working: number): QuitPrompt {
  const carryOn =
    working === 0
      ? "your threads carry on and the wsp command still answers. Quit and stop wsp stops it too."
      : working === 1
        ? `the thread working on ${THIS_COMPUTER} carries on. Quit and stop wsp stops that thread, then wsp.`
        : `the ${working} threads working on ${THIS_COMPUTER} carry on. Quit and stop wsp stops those threads, then wsp.`;
  return {
    message: "Quit wsp?",
    detail: `wsp keeps running in the background after the app quits, so ${carryOn}`,
    buttons: CHOICES.map(c => c.label),
    defaultId: 0,
    cancelId: CHOICES.findIndex(c => c.choice === "cancel"),
  };
}

/** The answer a dialog's button index is. */
export const quitChoice = (response: number): QuitChoice => CHOICES[response]?.choice ?? "cancel";
