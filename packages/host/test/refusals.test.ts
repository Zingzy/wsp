// SPDX-License-Identifier: AGPL-3.0-only
// The shape every refusal wsp leaves on a terminal: two halves, what happened
// then what to do, the command's name said once, and a word no command answers
// to met with a pointer at the help rather than the help itself.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_CODES } from "@wsp/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HELP, cli } from "../src/cli.js";
import { CLI_VERBS } from "../src/verbs.js";
import { captured, type Captured } from "./verbs-fixture.js";

describe("what wsp says when it will not run a line", () => {
  let dir: string;
  let statePath: string;
  let env: Record<string, string>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-refusals-"));
    statePath = join(dir, "state.json");
    env = { HOME: join(dir, "user"), WSP_HOME: join(dir, "home") };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = async (...argv: string[]): Promise<{ code: number; io: Captured }> => {
    const io = captured();
    // Nothing starts a host here: what a refused line says is the whole of this file, and a line that got as far as
    // the dial is held to the one sentence it leaves when there is nothing to reach.
    const code = await cli([...argv, "--state", statePath], io, undefined, env, false);
    return { code, io };
  };

  it("answers a word no command has with that word and where the list is, on one line, and never with the help", async () => {
    for (const word of ["ls", "list", "nope"]) {
      const { code, io } = await run(word);
      expect(code, word).toBe(EXIT_CODES.usage);
      expect(io.lines, word).toEqual([]);
      expect(io.errors, word).toEqual([`unknown command: ${word}. Run wsp --help for the list.`]);
      expect(io.errors.join("\n").split("\n"), word).toHaveLength(1);
    }
  });

  it("answers an unknown word under mcp and under host the same way, one line and a pointer, with no usage dump", async () => {
    const mcp = await run("mcp", "nope");
    expect(mcp.code).toBe(EXIT_CODES.usage);
    expect(mcp.io.errors).toEqual(["unknown command: mcp nope. Run wsp mcp --help for the list."]);
    // The word the plumbing folds under opens lines rather than being one, so it answers with the lines it opens.
    const host = await run("host", "nope");
    expect(host.code).toBe(EXIT_CODES.usage);
    expect(host.io.errors).toHaveLength(1);
    expect(host.io.errors[0]).toContain("wsp host opens a line rather than being one.");
    expect(host.io.errors[0]).toContain("usage: wsp host pair");
  });

  it("takes help as the word for the flag, printing what wsp --help prints and exiting 0", async () => {
    const word = await run("help");
    const flag = await run("--help");
    expect(word.code).toBe(0);
    expect(word.io.errors).toEqual([]);
    expect(word.io.lines).toEqual(flag.io.lines);
    expect(word.io.lines).toEqual([HELP]);
  });

  it("names the third word when a thread is opened on more than a workspace and a task", async () => {
    const { code, io } = await run("run", "api", "say hi", "and this");
    expect(code).toBe(EXIT_CODES.usage);
    expect(io.errors[0]).toContain("wsp run takes a workspace and a task; and this reads as a third word.");
    // The name is the line's own prefix, so the sentence behind it never says it a second time.
    expect(io.errors[0]!.startsWith("wsp run: wsp run")).toBe(false);
  });

  it("answers every word wsp used to have with the word it is now, in two halves, and dials nothing", async () => {
    const rows: [string[], string][] = [
      [["thread", "new", "x", "t"], "wsp thread new is now wsp run, with the workspace first."],
      [["pair"], "wsp pair is now wsp host pair."],
      [["devices"], "wsp devices is now wsp host devices."],
      [["connect", "http://box:4400"], "wsp connect is now wsp host connect."],
      [["hosts"], "wsp hosts is now wsp host list."],
      [["hosts", "default", "box"], "wsp hosts default is now wsp host default."],
      [["disconnect", "box"], "wsp disconnect is now wsp host forget."],
      [["relay", "link", "http://relay"], "wsp relay link is now wsp host link."],
      [["relay", "unlink"], "wsp relay unlink is now wsp host unlink."],
      [["relay", "hosts"], "wsp relay hosts is now wsp host linked."],
      [["relay", "clients"], "wsp relay clients is now wsp host clients."],
    ];
    for (const [argv, said] of rows) {
      const { code, io } = await run(...argv);
      const line = argv.join(" ");
      expect(code, line).toBe(EXIT_CODES.usage);
      expect(io.lines, line).toEqual([]);
      expect(io.errors, line).toHaveLength(1);
      expect(io.errors[0], line).toContain(said);
      // Both halves: what happened, then what to type instead.
      expect(io.errors[0], line).toMatch(/\. (Run|Put) /);
    }
    // A flag wsp used to read is answered the same way, by the parse of the verb that no longer reads it.
    const flags: [string[], string][] = [
      [["import", "/tmp/x", "--to", "alpha"], "so there is no --to"],
      [["threads", "--in", "alpha"], "so there is no --in"],
      [["new", "x", "--local"], "so wsp new --local is now --on"],
      [["new", "x", "--ssh", "maya@box"], "wsp new --ssh is gone"],
    ];
    for (const [argv, said] of flags) {
      const { code, io } = await run(...argv);
      const line = argv.join(" ");
      expect(code, line).toBe(EXIT_CODES.usage);
      expect(io.errors[0], line).toContain(said);
    }
    // A word that was never a verb still gets the unknown line and the pointer.
    const never = await run("ls");
    expect(never.io.errors).toEqual(["unknown command: ls. Run wsp --help for the list."]);
  });

  it("says a thread opened on no words at all what to put in quotes", async () => {
    const { code, io } = await run("run");
    expect(code).toBe(EXIT_CODES.usage);
    expect(io.errors).toEqual(['wsp run takes a task and got none. Put the task in quotes: wsp run <workspace> "say hi".']);
  });

  it("answers every verb in one line that never says the verb's name twice over, and refuses one with both halves", async () => {
    // Three words is more than any verb takes, so each one answers here rather than reaching for a host; the three
    // that read a list of words get as far as the dial, which has no host to reach and says so in one line too.
    for (const verb of CLI_VERBS) {
      const name = `wsp ${verb.name}`;
      const { code, io } = await run(...verb.name.split(" "), "zzz1", "zzz2", "zzz3");
      expect(io.lines, name).toEqual([]);
      expect(io.errors, name).toHaveLength(1);
      const line = io.errors[0]!;
      expect(line.split("\n"), name).toHaveLength(1);
      // The prefix is the one home for the verb's name; a sentence that opens with it again is the doubling.
      expect(line.startsWith(`${name}: ${name}`), `${name}: ${line}`).toBe(false);
      // A line refused before anything ran carries what to do: the verb's own usage, or a sentence of its own.
      if (code === EXIT_CODES.usage) expect(line, name).toMatch(/(?:usage: |\. [A-Z])/);
      else expect(code, `${name}: ${line}`).toBe(EXIT_CODES.provider);
    }
  });
});
