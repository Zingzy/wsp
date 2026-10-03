// SPDX-License-Identifier: AGPL-3.0-only
// What a press, a submit or a change does. set, toggle and fill run here; send, steer and queue leave the window
// through slates.act, which resolves the action off the host's own stored version and answers an outcome. The
// person's state writes go to the host through one sender per slate, typing debounced and every other change at once.
import { getSlateState, type SlateAction, type SlateEventName, type SlateJson } from "@wsp/protocol";
import type { SlateEngine } from "./engine.js";

/** The window's roads out for one slate, so a test draws a slate against a fake. */
export interface SlateLink {
  act(ask: SlateActAsk): Promise<{ outcome: string }>;
  writeState(values: Record<string, SlateJson>): Promise<unknown>;
  fill(text: string): void;
  /** Opens or focuses a right panel pane; false where the pane cannot open here. */
  pane?(kind: string): boolean;
  open?(href: string): void;
}

export interface SlateActAsk {
  version: number;
  piece: string;
  event: SlateEventName;
  action: number;
  requestId: string;
  /** The row of a repeating piece the press came from. */
  scope?: { item: SlateJson; index: number };
  /** Which of a table's row actions, where the press came from one. */
  rowAction?: number;
}

export interface RaiseOptions {
  /** A row action carries its own list; anything else runs the piece's `on`. */
  actions?: SlateAction | SlateAction[];
  row?: { item: SlateJson; index: number };
  rowAction?: number;
}

/** What the person sees under the piece for two seconds: an outcome, or a refusal sentence. */
export interface RaiseResult {
  said?: string;
  refused?: string;
}

/** Each outcome the runtime answers, in the copy voice (09-actions, outcomes). */
const OUTCOME_WORDS: Record<string, string> = {
  started: "Sent",
  sent: "Sent",
  steered: "Sent into the running turn",
  queued: "Waiting for the turn to end",
  next: "Nothing was running, so it was sent as the next message",
};
export const outcomeWord = (outcome: string): string => OUTCOME_WORDS[outcome] ?? outcome;

const DEBOUNCE_MS = 300;
const NOT_HERE = "This action is not in this build of the slate.";

/** The person's writes to one slate's state: typing waits 300 ms for the next keystroke, the rest go at once. */
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
    const value = getSlateState(this.#engine.state, path);
    return value === undefined ? Promise.resolve() : this.#send(path, value);
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

/** Runs a piece's actions for one event in order; the first refusal stops the list. */
export class ActionRunner {
  readonly #engine: SlateEngine;
  readonly #link: () => SlateLink;
  readonly #sender: StateSender;
  #counter = 0;

  constructor(engine: SlateEngine, link: () => SlateLink, sender: StateSender) {
    this.#engine = engine;
    this.#link = link;
    this.#sender = sender;
  }

  async raise(pieceId: string, event: SlateEventName, options: RaiseOptions = {}): Promise<RaiseResult> {
    const piece = this.#engine.piece(pieceId);
    const declared = options.actions ?? piece?.on?.[event];
    const list = declared === undefined ? [] : Array.isArray(declared) ? declared : [declared];
    let said: string | undefined;
    for (const [index, action] of list.entries()) {
      const result = await this.#run(pieceId, event, index, action, options);
      if (result.refused !== undefined) return result;
      if (result.said !== undefined) said = result.said;
    }
    return said === undefined ? {} : { said };
  }

  async #run(pieceId: string, event: SlateEventName, index: number, action: SlateAction, options: RaiseOptions): Promise<RaiseResult> {
    const engine = this.#engine;
    switch (action.do) {
      case "set": {
        if (!action.path.startsWith("state.")) return { refused: "set writes state paths only. Name a path under state." };
        await this.#sender.now(action.path, engine.resolve(action.value, options.row) ?? null);
        return {};
      }
      case "toggle": {
        if (!action.path.startsWith("state.")) return { refused: "toggle writes state paths only. Name a path under state." };
        await this.#sender.now(action.path, !truthy(getSlateState(engine.state, action.path)));
        return {};
      }
      case "fill": {
        const carried = (action.with ?? []).map(path => `${path}: ${JSON.stringify(engine.context(options.row).resolve(path) ?? null)}`);
        this.#link().fill(carried.length === 0 ? action.text : `${action.text}\n\n${carried.map(line => `> ${line}`).join("\n")}`);
        return {};
      }
      case "send":
      case "steer":
      case "queue": {
        this.#counter += 1;
        const ask: SlateActAsk = {
          version: engine.version,
          piece: pieceId,
          event,
          action: index,
          requestId: `${engine.threadId}:${engine.version}:${pieceId}:${this.#counter}`,
          ...(options.row !== undefined ? { scope: options.row } : {}),
          ...(options.rowAction !== undefined ? { rowAction: options.rowAction } : {}),
        };
        try {
          const { outcome } = await this.#link().act(ask);
          return { said: outcomeWord(outcome) };
        } catch (error) {
          return { refused: error instanceof Error ? error.message : String(error) };
        }
      }
      case "pane": {
        const opened = this.#link().pane?.(action.kind) ?? false;
        return opened ? {} : { refused: "That pane is not available here." };
      }
      case "open": {
        const href = engine.resolve(action.href, options.row);
        if (typeof href !== "string" || !/^https?:\/\//.test(href)) return { refused: "Only http and https links open from a slate." };
        this.#link().open?.(href);
        return {};
      }
      case "copy": {
        const text = engine.resolve(action.text, options.row);
        await navigator.clipboard?.writeText(typeof text === "string" ? text : JSON.stringify(text ?? ""));
        return { said: "Copied" };
      }
      default:
        return { refused: NOT_HERE };
    }
  }
}

export function truthy(value: SlateJson | undefined): boolean {
  if (value === undefined || value === null || value === false || value === 0 || value === "") return false;
  return !(Array.isArray(value) && value.length === 0);
}
