// SPDX-License-Identifier: AGPL-3.0-only
// What a press, a submit or a change does. The host runs set, toggle, start, cancel and the sends off its own stored
// version through slates.event, and answers an outcome, with the consent sheet's content when it held a run; fill,
// open, copy and pane run here (02-model, "Reactions"). The person's value writes go to the host through one sender
// per slate, typing debounced and every other change at once; a secret's text goes once and is not kept.
import type { SlateJson } from "@wsp/protocol";
import type { SlateEngine } from "./engine.js";
import { isHostStep, stepsOf, type SlateApproval, type SlateAsk, type SlateEventName, type SlateStep } from "./model.js";
import { getOwn } from "./paths.js";

export interface SlateEventAsk {
  version: number;
  piece: string;
  event: SlateEventName;
  requestId: string;
  /** The row of a repeating piece the press came from. */
  scope?: { item: SlateJson; index: number };
  /** Which of a table's row actions, where the press came from one. */
  rowAction?: number;
}

export interface SlateEventAnswer {
  outcome: string;
  said?: string;
  ask?: SlateAsk;
}

/** The window's roads out for one slate, so a test draws a slate against a fake. */
export interface SlateLink {
  event(ask: SlateEventAsk): Promise<SlateEventAnswer>;
  writeState(values: Record<string, SlateJson>): Promise<unknown>;
  /** Answers a held run's sheet by its approval key. */
  approve(key: string, scope: SlateApproval): Promise<unknown>;
  cancel(run: string): Promise<unknown>;
  /** Opens the consent sheet on a run a press held. */
  consent(ask: SlateAsk): void;
  fill(text: string): void;
  /** Opens or focuses a right panel pane; false where the pane cannot open here. */
  pane?(kind: string): boolean;
  open?(href: string): void;
}

export interface RaiseOptions {
  /** A row action carries its own list; anything else runs the piece's own handler. */
  actions?: SlateStep | SlateStep[];
  row?: { item: SlateJson; index: number };
  rowAction?: number;
}

/** What the person sees under the piece for two seconds: an outcome, or a refusal sentence. */
export interface RaiseResult {
  said?: string;
  refused?: string;
}

/** The send outcomes, in the copy voice (09-events, "Delivery"); any other outcome says nothing. */
const OUTCOME_WORDS: Record<string, string> = {
  started: "Sent",
  sent: "Sent",
  steered: "Sent into the running turn",
  queued: "Waiting for the turn to end",
};
export const outcomeWord = (outcome: string): string | undefined => OUTCOME_WORDS[outcome];

const DEBOUNCE_MS = 300;

/** The person's value writes to one slate: typing waits 300 ms for the next keystroke, the rest go at once. */
export class StateSender {
  readonly #engine: SlateEngine;
  readonly #link: () => SlateLink;
  #timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(engine: SlateEngine, link: () => SlateLink) {
    this.#engine = engine;
    this.#link = link;
  }

  type(path: string, value: SlateJson): void {
    this.#engine.writeLocal(path, value);
    const timer = this.#timers.get(path);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.set(path, setTimeout(() => void this.#send(path, value), DEBOUNCE_MS));
  }

  now(path: string, value: SlateJson): Promise<void> {
    this.#engine.writeLocal(path, value);
    return this.#send(path, value);
  }

  /** Sends what a field holds at once: on blur, Enter or a submit. */
  flush(path: string): Promise<void> {
    const timer = this.#timers.get(path);
    if (timer === undefined) return Promise.resolve();
    clearTimeout(timer);
    this.#timers.delete(path);
    const value = getOwn(this.#engine.values, path);
    return value === undefined ? Promise.resolve() : this.#send(path, value);
  }

  /** A secret's text, sent once and never written into the window's values: once the host has it, the window
   * holds the handle alone (08, "Where the plaintext lives"). An empty text clears it. */
  async secret(path: string, text: string): Promise<void> {
    await this.#link().writeState({ [path]: text });
    this.#engine.settle(path, { secret: true, set: text !== "", len: text.length, at: Date.now() });
    this.#engine.invalidate([path]);
  }

  async #send(path: string, value: SlateJson): Promise<void> {
    this.#timers.delete(path);
    this.#engine.noteSent(path, value);
    try {
      await this.#link().writeState({ [path]: value });
      this.#engine.settle(path, value);
    } catch {
      // The value stays drawn as typed; the next keystroke or a reconnect's fetch sends or replaces it.
    }
  }

  dispose(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }
}

/** Runs one event's steps: the host's part as one slates.event, then the window's own in order. */
export class ActionRunner {
  readonly #engine: SlateEngine;
  readonly #link: () => SlateLink;
  #counter = 0;

  constructor(engine: SlateEngine, link: () => SlateLink) {
    this.#engine = engine;
    this.#link = link;
  }

  async raise(pieceId: string, event: SlateEventName, options: RaiseOptions = {}): Promise<RaiseResult> {
    const steps = stepsOf(options.actions ?? this.#engine.piece(pieceId)?.on?.[event]);
    let said: string | undefined;
    if (steps.some(isHostStep)) {
      const engine = this.#engine;
      this.#counter += 1;
      const ask: SlateEventAsk = {
        version: engine.version,
        piece: pieceId,
        event,
        requestId: `${engine.threadId}:${engine.version}:${pieceId}:${this.#counter}`,
        ...(options.row !== undefined ? { scope: options.row } : {}),
        ...(options.rowAction !== undefined ? { rowAction: options.rowAction } : {}),
      };
      try {
        const answer = await this.#link().event(ask);
        if (answer.ask !== undefined) this.#link().consent(answer.ask);
        said = answer.said ?? outcomeWord(answer.outcome);
      } catch (error) {
        return { refused: error instanceof Error ? error.message : String(error) };
      }
    }
    for (const step of steps) {
      if (isHostStep(step)) continue;
      const result = await this.#window(step, options);
      if (result.refused !== undefined) return result;
      if (result.said !== undefined) said = result.said;
    }
    return said === undefined ? {} : { said };
  }

  cancel(run: string): Promise<unknown> {
    return this.#link().cancel(run);
  }

  async #window(step: SlateStep, options: RaiseOptions): Promise<RaiseResult> {
    const engine = this.#engine;
    switch (step.do) {
      case "fill": {
        const read = engine.reader(options.row);
        const carried = (step.with ?? []).map(path => `${path}: ${JSON.stringify(read(path) ?? null)}`);
        this.#link().fill(carried.length === 0 ? step.text : `${step.text}\n\n${carried.map(line => `> ${line}`).join("\n")}`);
        return {};
      }
      case "pane": {
        const opened = this.#link().pane?.(step.kind) ?? false;
        return opened ? {} : { refused: "That pane is not available here." };
      }
      case "open": {
        const href = engine.resolve(step.target, options.row);
        if (typeof href !== "string" || !/^(https?:\/\/|mailto:)/.test(href)) return { refused: "Only http, https and mailto links open from a slate." };
        this.#link().open?.(href);
        return {};
      }
      case "copy": {
        const text = engine.resolve(step.text, options.row);
        await navigator.clipboard?.writeText(typeof text === "string" ? text : JSON.stringify(text ?? ""));
        return { said: "Copied" };
      }
      default:
        return {};
    }
  }
}

export function truthy(value: SlateJson | undefined): boolean {
  if (value === undefined || value === null || value === false || value === 0 || value === "") return false;
  return !(Array.isArray(value) && value.length === 0);
}
