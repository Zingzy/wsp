// SPDX-License-Identifier: AGPL-3.0-only
// A reply's shell block that a person can run where it stands: which labels run, the command a block holds, and the
// text a finished run leaves behind it, read by the app that draws the block and the host that keeps the record.

/** The fence labels a reply's block runs under. Text, no label and every other language get no Run: the one thing
 * that makes a block a command for the person is the agent saying so. */
export const SHELL_FENCES: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "shell", "console"]);

/** The sentence the launch context and the skill carry, so the command an agent means for the person comes labelled
 * as one: written once here and quoted, and a label it does not name gets no Run. */
export const RUN_BLOCK_WORDS = "A command you mean the person to run goes in a fenced block labelled `sh`, which the app shows with Run: the person runs it with one click, in this thread's folder, and sees its output under the block";

/** Characters a page draws reordered, not at all, or as nothing: bidirectional overrides and isolates, zero-width
 * marks, and every control but tab and newline. A block holding one can run something other than what it shows. */
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

/** The command a block holds, or nothing where the block is not one to run. A console block is a transcript: its
 * `$ ` lines are the commands and the lines between them are output, left out. */
export function runnableCommand(language: string, code: string): string | null {
  const label = language.trim().toLowerCase();
  if (!SHELL_FENCES.has(label)) return null;
  const text = code.replace(/\r\n/g, "\n");
  if (HIDDEN.test(text)) return null;
  const lines = text.split("\n");
  const prompted = label === "console" ? lines.filter(l => l.startsWith("$ ")).map(l => l.slice(2)) : [];
  const command = (prompted.length > 0 ? prompted.join("\n") : text).trim();
  return command === "" ? null : command;
}

/** The first daemon that runs a command in a pty: an older one takes the command for no field at all and opens a
 * plain shell, so a run is refused on it rather than started. */
export const PTY_RUN_DAEMON_VERSION = 98;

/** The most of a run's output the thread keeps: the tail, which is where a failure says why. */
export const RUN_OUTPUT_MAX_CHARS = 64 * 1024;

/** The tail of a run's output under the cap, starting at a line's start so the first line is never half of one. */
export function runOutputTail(text: string, max: number = RUN_OUTPUT_MAX_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.slice(-max);
  const newline = cut.indexOf("\n");
  return newline < 0 ? cut : cut.slice(newline + 1);
}

/** A terminal's bytes as the lines a person saw: escape sequences carry no text, a carriage return starts its line
 * over, and a backspace takes the letter before it. What a cursor move redraws in the middle of the screen is not
 * followed; a finished run's text is its lines, not its last frame. */
export function terminalText(raw: string): string {
  const out: string[] = [];
  let line: string[] = [];
  let col = 0;
  const put = (ch: string): void => {
    line[col] = ch;
    col += 1;
  };
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === "\x1b") {
      const next = raw[i + 1];
      if (next === "[") {
        // CSI: parameters and intermediates up to the final byte, 0x40 to 0x7e.
        let j = i + 2;
        while (j < raw.length && !/[\x40-\x7e]/.test(raw[j]!)) j++;
        i = j;
      } else if (next === "]" || next === "P" || next === "_" || next === "^") {
        // OSC, DCS, APC and PM: a string up to BEL or ST.
        let j = i + 2;
        while (j < raw.length && raw[j] !== "\x07" && !(raw[j] === "\x1b" && raw[j + 1] === "\\")) j++;
        i = raw[j] === "\x07" ? j : j + 1;
      } else {
        // Two bytes, or an intermediate run (0x20 to 0x2f) and its final: ESC ( B, ESC # 8.
        let j = i + 1;
        while (j < raw.length && raw.charCodeAt(j) >= 0x20 && raw.charCodeAt(j) <= 0x2f) j++;
        i = j;
      }
      continue;
    }
    if (ch === "\r") {
      col = 0;
      continue;
    }
    if (ch === "\n") {
      out.push(line.join(""));
      line = [];
      col = 0;
      continue;
    }
    if (ch === "\b") {
      col = Math.max(0, col - 1);
      line.length = Math.min(line.length, col);
      continue;
    }
    if (ch < " " && ch !== "\t") continue;
    put(ch);
  }
  out.push(line.join(""));
  while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
  return out.map(l => l.replace(/\s+$/, "")).join("\n");
}

/** A reply block's name on the thread's record: the reply's message and where the block's fence starts in its text,
 * which stays put for as long as the reply does. */
export const runBlockKey = (messageId: string, offset: number): string => `${messageId}@${offset}`;

/** How long a run prints before it is offered a terminal tab: a quick command is over by then, and one still going
 * is likely a server or a watch that belongs in a tab. */
export const RUN_MOVE_AFTER_MS = 3000;

/** The words a run's block draws, one table for the app and the tests that read it. */
export const RUN_WORDS = {
  run: "Run",
  runAgain: "Run again",
  running: "Running",
  move: "Move to terminal",
  send: "Send output to the agent",
  openTab: "Open the tab",
} as const;

/** How a run ended, in the line under its output. */
export function runEndedWords(run: { state: "exited" | "moved" | "lost" | "running"; exitCode?: number; signal?: number }): string {
  if (run.state === "moved") return "Moved to a terminal tab";
  if (run.state === "lost") return "Ended unseen: its terminal went away first";
  if (run.state === "running") return RUN_WORDS.running;
  if (run.signal !== undefined) return `Stopped by signal ${run.signal}`;
  return `Exited ${run.exitCode ?? 0}`;
}

/** The most lines of a run's output a sent message carries: the tail an agent needs to read a failure, and no more. */
export const RUN_SENT_LINES = 60;

/** What Send output to the agent sends into the thread as the person's message: the command, how it ended and the
 * tail of what it printed. */
export function runOutputMessage(command: string, run: { state: "exited" | "moved" | "lost" | "running"; exitCode?: number; signal?: number }, output: string): string {
  const ended = run.state === "exited" && run.signal === undefined ? `it exited ${run.exitCode ?? 0}` : runEndedWords(run).toLowerCase();
  const lines = output.split("\n");
  const tail = lines.slice(-RUN_SENT_LINES).join("\n");
  if (output.trim() === "") return `I ran \`${command}\` and ${ended}. It printed nothing.`;
  // Longer than any run of backticks the output holds, so no line of it closes the fence and reads as the person's.
  const longest = Math.max(0, ...[...tail.matchAll(/`+/g)].map(m => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `I ran \`${command}\` and ${ended}. The last lines it printed:\n\n${fence}text\n${tail}\n${fence}`;
}
