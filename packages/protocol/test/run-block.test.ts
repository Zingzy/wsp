// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { RUN_BLOCK_WORDS, RUN_OUTPUT_MAX_CHARS, RUN_SENT_LINES, SHELL_FENCES, runBlockKey, runEndedWords, runOutputMessage, runOutputTail, runnableCommand, terminalText } from "../src/run-block.js";

describe("which of a reply's code blocks a person can run", () => {
  it("runs a block labelled as a shell, and never one labelled text, one with no label or one in another language", () => {
    for (const label of ["sh", "bash", "zsh", "shell", "console"]) expect(runnableCommand(label, "kill 60082 60083\n"), label).toBe("kill 60082 60083");
    expect([...SHELL_FENCES].sort()).toEqual(["bash", "console", "sh", "shell", "zsh"]);
    for (const label of ["text", "", "python", "js", "ts", "diff", "sh-session"]) expect(runnableCommand(label, "ls"), label || "no label").toBeNull();
    // The label is the fence's word as an agent writes it, in either case.
    expect(runnableCommand("Bash", "ls")).toBe("ls");
  });

  it("strips a console block's prompts and leaves out the output lines between them", () => {
    expect(runnableCommand("console", "$ npm install\nadded 3 packages\n$ npm test\n")).toBe("npm install\nnpm test");
    // A console block with no prompt at all is the command as written.
    expect(runnableCommand("console", "npm test")).toBe("npm test");
    // Only a console block's prompts are its own: a shell block keeps a $ that is part of the command.
    expect(runnableCommand("sh", "$ echo $HOME")).toBe("$ echo $HOME");
  });

  it("offers nothing to run for a block that is empty once trimmed", () => {
    expect(runnableCommand("sh", "  \n\n")).toBeNull();
    expect(runnableCommand("console", "just output\n")).toBe("just output");
  });

  it("says in one sentence how an agent labels a command for the person", () => {
    expect(RUN_BLOCK_WORDS).toContain("`sh`");
    expect(RUN_BLOCK_WORDS.endsWith(".")).toBe(false);
  });
});

describe("a finished run's output as text", () => {
  it("drops the terminal's escapes and keeps what a person saw on each line", () => {
    expect(terminalText("\x1b[32mok\x1b[0m\r\nnext\r\n")).toBe("ok\nnext");
    // A progress line redrawn with a carriage return keeps its last drawing.
    expect(terminalText("10%\r50%\r100%\r\ndone")).toBe("100%\ndone");
    // A backspace takes the letter before it, as a prompt that corrects itself shows.
    expect(terminalText("abx\bc")).toBe("abc");
    // Title and hyperlink sequences end at BEL or ST and carry no text.
    expect(terminalText("\x1b]0;title\x07a\x1b]8;;https://x\x1b\\b")).toBe("ab");
    expect(terminalText("\x1b[?2004h\x1b[1;2Hhere")).toBe("here");
  });

  it("keeps the tail of a long output, from a line's start, under its cap", () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join("\n");
    const tail = runOutputTail(lines);
    expect(tail.length).toBeLessThanOrEqual(RUN_OUTPUT_MAX_CHARS);
    expect(tail.endsWith("line 19999")).toBe(true);
    expect(tail.startsWith("line ")).toBe(true);
    expect(runOutputTail("short")).toBe("short");
  });
});

describe("what a finished run says and sends", () => {
  it("names a block by its reply and its place in the reply's text", () => {
    expect(runBlockKey("turn-1:m2", 40)).toBe("turn-1:m2@40");
  });

  it("says how a run ended in one short line", () => {
    expect(runEndedWords({ state: "exited", exitCode: 0 })).toBe("Exited 0");
    expect(runEndedWords({ state: "exited", exitCode: 1 })).toBe("Exited 1");
    expect(runEndedWords({ state: "exited", exitCode: 0, signal: 15 })).toBe("Stopped by signal 15");
    expect(runEndedWords({ state: "moved" })).toBe("Moved to a terminal tab");
    expect(runEndedWords({ state: "lost" })).toBe("Ended unseen: its terminal went away first");
  });

  it("sends the command, how it ended and the tail of its output as the person's message", () => {
    const output = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const message = runOutputMessage("npm test", { state: "exited", exitCode: 1 }, output);
    expect(message.startsWith("I ran `npm test` and it exited 1. The last lines it printed:\n\n```text\n")).toBe(true);
    expect(message.endsWith("line 199\n```")).toBe(true);
    expect(message.split("\n").filter(l => l.startsWith("line "))).toHaveLength(RUN_SENT_LINES);
    expect(runOutputMessage("true", { state: "exited", exitCode: 0 }, "")).toBe("I ran `true` and it exited 0. It printed nothing.");
  });
});
