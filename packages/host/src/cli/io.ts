// SPDX-License-Identifier: AGPL-3.0-only
import type { Readable, Writable } from "node:stream";
import { isCancel } from "@clack/prompts";
import { authRefusal } from "@wsp/protocol";
import { KEY_LAYER_WORDS } from "../env-keys.js";
import { colourDepth, confirmPrompt, isTTY, muted, passwordPrompt, widthOf, type PromptOptions } from "../init-layout.js";
import type { Redraw } from "../watch.js";

export interface CliIO {
  log(line: string): void;
  error(line: string): void;
  /** Raw text on stderr, no newline added: a reply as it streams in. */
  stream?(text: string): void;
  /** Where a list that refreshes where it stands redraws: raw writes to stdout and the width to count wrapped rows
   * at, both off that one stream. Present only where stdout is a terminal, so a line that takes --watch reads its
   * absence as there being nothing to redraw on. */
  redraw?: Redraw;
  /** The same text, standing back from the reply it sits beside, as far as the stream's colours go; absent leaves it plain. */
  muted?(text: string): string;
  /** This process's own stdin and stdout as bytes, for a line that pipes them; absent on a line carried here from
   * a machine, which has no stream of this computer's to hand over. */
  bytes?: { input: Readable; output: Writable };
  /** A yes-or-no question; resolves to "yes" or "no". */
  ask(question: string): Promise<string>;
  /** A person is at the keyboard (stdin and stdout are terminals); absent means an agent or a pipe, and nothing is asked. */
  isTTY?: boolean;
  /** What the stream writes and what log prints land in front of the same eyes (stdout and stderr are both
   * terminals), so text the stream has already shown is not printed a second time under it. Absent, the two part:
   * stdout carries the answer whole and the stream is somebody else's view of the work. */
  sameScreen?: boolean;
  /** A key, typed without echo. Lines after the first are shown under the question. `variable` is what a caller
   * with no terminal is told to set instead, so a refusal in a service log names the key to put in a file rather
   * than saying it. */
  askSecret(question: string, variable?: string): Promise<string>;
  /** One of a set of answers, typed while something else is running: the answer, or nothing when `until` settles
   * first, which is the question being answered somewhere else or going with what asked it. Absent where nobody is
   * at the keyboard, and a caller that reads it absent says the other road to answer on instead. */
  answerKey?(accept: readonly string[], until: Promise<unknown>): Promise<string | undefined>;
}

type Stream<T> = T & { isTTY?: boolean };

/** Questions are clack prompts on the terminal; off a terminal there is nobody to answer them. */
export function terminalIO(input: Stream<Readable> = process.stdin, output: Stream<Writable> = process.stdout): CliIO {
  const screen = input.isTTY === true && output.isTTY === true;
  const nobodyLine = (q: string, variable?: string): string => `${q.split("\n")[0]}: no terminal to ask on; set ${variable ?? "it"} in ${KEY_LAYER_WORDS}.`;
  const nobody = (q: string): Promise<never> => Promise.reject(new Error(nobodyLine(q)));
  // A secret nobody can type is a missing key, the contract's auth class; a yes-or-no nobody can answer is not.
  const noKey = (q: string, variable?: string): Promise<never> => Promise.reject(authRefusal(nobodyLine(q, variable)));
  // The first line of a question is the question; the lines under it are its hint.
  const split = (q: string): PromptOptions => {
    const nl = q.indexOf("\n");
    return nl < 0 ? { message: q, input, output } : { message: q.slice(0, nl), hint: q.slice(nl + 1), input, output };
  };
  const answered = async <T>(prompt: Promise<T | symbol>): Promise<T> => {
    const value = await prompt;
    if (isCancel(value)) throw new Error("Nothing was changed.");
    return value as T;
  };
  return {
    log: line => console.log(line),
    error: line => console.error(line),
    stream: text => process.stderr.write(text),
    bytes: { input, output },
    ...(isTTY(output) ? { redraw: { write: (text: string) => void output.write(text), columns: () => widthOf(output, Infinity) } } : {}),
    muted: text => muted(text, colourDepth(isTTY(process.stderr))),
    isTTY: screen,
    sameScreen: isTTY(output) && isTTY(process.stderr),
    ask: q => (screen ? answered(confirmPrompt(split(q))).then(yes => (yes ? "yes" : "no")) : nobody(q)),
    askSecret: (q, variable) => (screen ? answered(passwordPrompt(split(q))) : noKey(q, variable)),
    ...(screen ? { answerKey: (accept: readonly string[], until: Promise<unknown>) => readAnswerKey(input, accept, until) } : {}),
  };
}

/** One of a set of answers typed at the terminal while a turn streams beside it. The line is read as the terminal
 * gives it, never in raw mode: a turn a person may be watching for an hour must keep the ctrl-c the terminal itself
 * turns into a signal, and a raw read swallows it. A word outside the set is ignored and the question stands. */
function readAnswerKey(input: Stream<Readable>, accept: readonly string[], until: Promise<unknown>): Promise<string | undefined> {
  return new Promise(resolve => {
    const done = (value: string | undefined): void => {
      input.off("data", onData);
      input.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      const typed = String(chunk).trim().toLowerCase();
      if (accept.includes(typed)) done(typed);
    };
    input.on("data", onData);
    input.resume();
    void until.then(() => done(undefined));
  });
}

/** What an init under --json speaks through: stdout carries the objects alone, so every line the run says goes to
 * stderr beside them, and a key that is not in the environment or a .env file is an error rather than a prompt on a
 * stream nobody is reading. */
export function jsonCliIO(err: Writable = process.stderr): CliIO {
  const say = (line: string): void => void err.write(`${line}\n`);
  const nobodyLine = (q: string, variable?: string): string => `${q.split("\n")[0]}: --json asks nothing; set ${variable ?? "it"} in ${KEY_LAYER_WORDS}.`;
  const nobody = (q: string): Promise<never> => Promise.reject(new Error(nobodyLine(q)));
  const noKey = (q: string, variable?: string): Promise<never> => Promise.reject(authRefusal(nobodyLine(q, variable)));
  return { log: say, error: say, stream: text => void err.write(text), ask: nobody, askSecret: noKey };
}
