// SPDX-License-Identifier: AGPL-3.0-only
// The handler step kinds of 02 ("Reactions"): what each does, where it runs, what consent it needs and how it is
// written. The compiler, the validator, the batch and the catalog read this table.
export interface SlateStepModule {
  kind: string;
  /** host: the batch applies it. window: the window that raised the press does, so only a press may hold it. */
  runs: "host" | "window";
  sig: string;
  purpose: string;
  consent: string;
  example: string;
}

export const SLATE_STEPS: Readonly<Record<string, SlateStepModule>> = {
  set: { kind: "set", runs: "host", sig: "set($path, value)", purpose: "writes a value; later steps read the new value", consent: "none", example: "set($step, 2)" },
  toggle: { kind: "toggle", runs: "host", sig: "toggle($path)", purpose: "flips a boolean value", consent: "none", example: "toggle($showDone)" },
  start: { kind: "start", runs: "host", sig: "start($run)", purpose: "starts a run; does not wait; its end fires <when done>", consent: "the person approves the command once", example: "start($check)" },
  cancel: { kind: "cancel", runs: "host", sig: "cancel($run)", purpose: "stops a running run", consent: "none", example: "cancel($tests)" },
  send: { kind: "send", runs: "host", sig: "send(\"text\", $path, ...)", purpose: "a message to the agent: the text, then slate: {...} with the paths as data", consent: "a press is the consent; from a reaction, one approval per slate", example: "send(\"Fix the failing check.\", item.name)" },
  steer: { kind: "steer", runs: "host", sig: "steer(\"text\", $path, ...)", purpose: "as send, into the running turn", consent: "as send", example: "steer(\"Look at the failing check first.\")" },
  queue: { kind: "queue", runs: "host", sig: "queue(\"text\", $path, ...)", purpose: "as send, after the running turn (a send until the flag lands)", consent: "as send", example: "queue(\"Then open the pull request.\")" },
  fill: { kind: "fill", runs: "window", sig: "fill(\"text\", $path, ...)", purpose: "puts the text in the composer, not sent", consent: "none; a press only", example: "fill(\"About this branch:\", git.branch)" },
  open: { kind: "open", runs: "window", sig: "open(url or path)", purpose: "opens a URL or a file in the thread's folder", consent: "once per domain; a press only", example: "open(pr.url)" },
  copy: { kind: "copy", runs: "window", sig: "copy(text)", purpose: "copies to the clipboard", consent: "none; a press only", example: "copy(git.head)" },
  pane: { kind: "pane", runs: "window", sig: "pane(\"kind\")", purpose: "opens a right panel tab", consent: "none; a press only", example: "pane(\"pr\")" },
};
