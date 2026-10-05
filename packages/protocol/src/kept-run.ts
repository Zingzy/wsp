// SPDX-License-Identifier: AGPL-3.0-only
// One harness process serving a thread's turns one after another. Each turn reads the process through a view of
// its own: the lines from the moment the turn opens until the turn closes its view's input, which ends that turn and
// leaves the process up for the next one. An adapter's turn reader is written against one ExecStream per turn, so
// a view is one: nothing in the reader changes for a turn on a kept process except what ends it.
import type { AdapterEvent, ExecStream, TurnImage } from "./adapter-port.js";
import { endAfterResult } from "./adapter-port.js";

/** The process behind a thread's turns, kept up between them, as an adapter hands it to the runtime once a turn on it
 * is over. */
export interface KeptAgent<Session> {
  /** The thread's next turn on this process, its message written to the process at once. */
  next(turn: KeptTurn): Session;
  /** Ends the process: EOF on its input, then its tree once the waits pass; `now` sends its tree SIGTERM at once, for
   * a host that is going and will read it no more. */
  close(o?: { now?: true }): Promise<void>;
  /** Settles when the process is gone, however it went. */
  readonly exited: Promise<unknown>;
  /** Where the agent keeps this session's own file on the computer the process runs on: the one file whose name ends
   * in `name`, `depth` folders under `folder`. One that changed between two turns was written by another process. */
  readonly sessionFile?: { folder: string; name: string; depth: number };
}

/** What a next turn on a kept process takes. Everything else the process was launched with stands, and a turn that
 * needs any of it changed is launched cold instead. */
export interface KeptTurn {
  prompt: string;
  images?: readonly TurnImage[];
  /** The message reaches the process once this settles, held beside the run meanwhile where the road keeps one. */
  after?: Promise<void>;
  onEvent: (event: AdapterEvent) => void;
}

export interface KeptRun {
  /** A view of the process for one turn, reading the lines it prints from now on. A view's closeInput ends the turn
   * and not the process, which rests until the next view opens. `from` is where the turn starts in the run's log, on
   * every view after the first. */
  turn(): { stream: ExecStream; from?: number };
  /** The turn open now takes the process with it: its view's closeInput reaches the process itself and its lines run
   * on to the exit, as a turn on a process nobody keeps does. */
  release(): void;
  /** The process is up and nobody released it, so a next turn may open on it. */
  readonly up: boolean;
  readonly exited: Promise<number | null>;
  close(waitMs: number, graceMs: number): Promise<void>;
}

/** Lines queued for one reader as they arrive, ended by hand or by the process. */
class Queue {
  private readonly lines: string[] = [];
  private wake: (() => void) | undefined;
  private done = false;
  private error: unknown;

  push(line: string): void {
    if (this.done) return;
    this.lines.push(line);
    this.wake?.();
  }

  end(error?: unknown): void {
    if (this.done) return;
    this.done = true;
    this.error = error;
    this.wake?.();
  }

  /** Ends at once, dropping what was not read yet: whatever the process printed after its turn closed is no turn's. */
  cut(): void {
    this.lines.length = 0;
    this.end();
  }

  async *iterate(): AsyncGenerator<string> {
    for (;;) {
      while (this.lines.length > 0) yield this.lines.shift()!;
      if (this.done) {
        if (this.error !== undefined) throw this.error;
        return;
      }
      await new Promise<void>(resolve => (this.wake = resolve));
      this.wake = undefined;
    }
  }
}

export function keepRun(stream: ExecStream): KeptRun {
  let open: { queue: Queue; settle: (code: number | null) => void } | undefined;
  let released = false;
  let ended = false;
  let failure: unknown;
  let code: number | null = null;
  // One reader for the process's whole life; a line printed while no turn is open goes to nobody. The turn open when
  // the process goes reads every line it printed before it hears the end.
  void (async () => {
    try {
      for await (const line of stream.lines) open?.queue.push(line);
    } catch (e) {
      failure = e;
    }
    code = await stream.exited;
    ended = true;
    open?.queue.end(failure);
    open?.settle(code);
  })();

  let turns = 0;
  const turn = (): { stream: ExecStream; from?: number } => {
    const from = turns++ === 0 ? undefined : stream.nextTurn?.();
    open?.queue.cut();
    const queue = new Queue();
    let closed = false;
    let settle: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>(resolve => (settle = resolve));
    const mine = { queue, settle };
    open = mine;
    if (ended) {
      queue.end(failure);
      settle(code);
    }
    const view: ExecStream = {
      lines: queue.iterate(),
      ...(stream.run !== undefined ? { run: stream.run } : {}),
      ...(stream.pid !== undefined ? { pid: stream.pid } : {}),
      teardown: () => stream.teardown(),
      kill: () => stream.kill(),
      write: async line => (closed ? "gone" : stream.write(line)),
      closeInput: () => {
        if (closed) return;
        closed = true;
        if (released) {
          stream.closeInput();
          return;
        }
        if (open === mine) open = undefined;
        queue.cut();
        stream.rest?.();
        settle(0);
      },
      ...(stream.writeAfter !== undefined ? { writeAfter: stream.writeAfter.bind(stream) } : {}),
      exited,
      get signalled() {
        return ended ? stream.signalled : undefined;
      },
    };
    return { stream: view, ...(from !== undefined ? { from } : {}) };
  };

  return {
    turn,
    release: () => {
      released = true;
    },
    get up() {
      return !ended && !released;
    },
    exited: stream.exited,
    close: async (waitMs, graceMs) => {
      released = true;
      stream.closeInput();
      await endAfterResult(stream, waitMs, graceMs);
    },
  };
}
