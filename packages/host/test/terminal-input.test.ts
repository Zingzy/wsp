// SPDX-License-Identifier: AGPL-3.0-only
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { TerminalInput } from "../src/terminal-input.js";

function streams(tty: boolean): { input: PassThrough & { isTTY: boolean; setRawMode(on: boolean): void }; out: string[]; raw: boolean[] } {
  const raw: boolean[] = [];
  const input = Object.assign(new PassThrough(), {
    isTTY: tty,
    setRawMode(on: boolean) {
      raw.push(on);
    },
  });
  const out: string[] = [];
  const output = new PassThrough();
  output.on("data", (c: Buffer) => out.push(c.toString()));
  return { input, out, raw };
}

function tick(): Promise<void> {
  return new Promise(r => setImmediate(r));
}

describe("TerminalInput", () => {
  it("hands out queued lines in order when several arrive in one chunk", async () => {
    const { input, out } = streams(false);
    const term = new TerminalInput(input, new PassThrough().on("data", (c: Buffer) => out.push(c.toString())));
    const first = term.ask("one? ");
    input.write("alpha\nbeta\ngamma\n");
    expect(await first).toBe("alpha");
    expect(await term.ask("two? ")).toBe("beta");
    expect(await term.ask("three? ")).toBe("gamma");
    expect(out.join("")).toBe("one? two? three? ");
  });

  it("resolves with the partial line on end of input", async () => {
    const { input } = streams(false);
    const term = new TerminalInput(input, new PassThrough());
    const p = term.ask("? ");
    input.end("no newline");
    expect(await p).toBe("no newline");
    expect(await term.ask("again? ")).toBe("");
  });

  it("reads a secret in raw mode on a tty, echoing nothing but the question and a newline", async () => {
    const { input, out, raw } = streams(true);
    const output = new PassThrough();
    output.on("data", (c: Buffer) => out.push(c.toString()));
    const term = new TerminalInput(input, output);
    const p = term.askSecret("key: ");
    await tick();
    expect(raw).toEqual([true]);
    for (const ch of ["s", "k", "-", "x", "", "y", "\r"]) input.write(ch);
    expect(await p).toBe("sk-y");
    expect(raw).toEqual([true, false]);
    expect(out.join("")).toBe("key: \n");
  });

  it("falls back to a plain line off a tty and still echoes nothing itself", async () => {
    const { input, out, raw } = streams(false);
    const output = new PassThrough();
    output.on("data", (c: Buffer) => out.push(c.toString()));
    const term = new TerminalInput(input, output);
    const p = term.askSecret("key: ");
    input.write("sk-ant-x-plain\n");
    expect(await p).toBe("sk-ant-x-plain");
    expect(raw).toEqual([]);
    expect(out.join("")).toBe("key: ");
  });

  it("rejects on ctrl-c in raw mode and restores the terminal", async () => {
    const { input, raw } = streams(true);
    const term = new TerminalInput(input, new PassThrough());
    const p = term.askSecret("key: ");
    await tick();
    input.write("ab");
    await expect(p).rejects.toThrow(/interrupted/);
    expect(raw).toEqual([true, false]);
  });

  it("pauses the input between questions so an idle process can exit", async () => {
    const { input } = streams(false);
    const term = new TerminalInput(input, new PassThrough());
    const p = term.ask("? ");
    await tick();
    expect(input.isPaused()).toBe(false);
    input.write("x\n");
    await p;
    expect(input.isPaused()).toBe(true);
  });
});
