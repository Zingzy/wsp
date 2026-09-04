// SPDX-License-Identifier: AGPL-3.0-only
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { unicode } from "@clack/prompts";
import { S_BAR_FOCUS, S_BAR_FOCUS_END, card, colourDepth, ellipsize, fmtDuration, helpLine, rowsOf, summarize, table, viewport, widthOf, wrap } from "../src/init-layout.js";

describe("init layout", () => {
  it("ellipsize keeps text that fits and ends cut text with one ellipsis inside the width", () => {
    expect(ellipsize("abc", 3)).toBe("abc");
    expect(ellipsize("abcdef", 4)).toBe("abc…");
    expect(ellipsize("abcdef", 1)).toBe("…");
    expect(ellipsize("abcdef", 0)).toBe("");
  });

  it("table pads each column to its widest cell, right-aligns where asked, and leaves no trailing space", () => {
    const rows = table(
      [
        ["Identity", "10", "82.9 KB", "3 can come"],
        ["Tools", "161", "", "92 can come"],
        ["Shell", "9", "1.1 MB", ""],
      ],
      ["left", "right", "right"],
    );
    expect(rows).toEqual([
      "Identity   10  82.9 KB  3 can come",
      "Tools     161           92 can come",
      "Shell       9   1.1 MB",
    ]);
  });

  it("fmtDuration shows tenths under a minute and minutes past it", () => {
    expect(fmtDuration(340)).toBe("0.3s");
    expect(fmtDuration(59_949)).toBe("59.9s");
    expect(fmtDuration(61_000)).toBe("1m 01s");
    expect(fmtDuration(600_000)).toBe("10m 00s");
  });

  it("widthOf reads the stream's columns, falls back to 80, and caps at 100", () => {
    expect(widthOf(new PassThrough())).toBe(80);
    expect(widthOf(Object.assign(new PassThrough(), { columns: 48 }))).toBe(48);
    expect(widthOf(Object.assign(new PassThrough(), { columns: 240 }))).toBe(100);
    expect(widthOf(undefined)).toBe(80);
  });

  it("rowsOf reads the stream's rows and falls back to 20", () => {
    expect(rowsOf(new PassThrough())).toBe(20);
    expect(rowsOf(Object.assign(new PassThrough(), { rows: 30 }))).toBe(30);
    expect(rowsOf(undefined)).toBe(20);
  });

  it("viewport keeps the cursor mid-window, pins the window at both ends, and never goes under one row", () => {
    expect(viewport(20, 0, 5)).toEqual({ start: 0, end: 5 });
    expect(viewport(20, 10, 5)).toEqual({ start: 8, end: 13 });
    expect(viewport(20, 19, 5)).toEqual({ start: 15, end: 20 });
    expect(viewport(3, 1, 5)).toEqual({ start: 0, end: 3 });
    expect(viewport(20, 7, 0)).toEqual({ start: 7, end: 8 });
    expect(viewport(0, 0, 4)).toEqual({ start: 0, end: 0 });
  });

  it("summarize names up to three labels then +N more, drops labels when the width is short, and cuts the last one kept", () => {
    expect(summarize(["a", "b"], 80)).toBe("a, b");
    expect(summarize(["a", "b", "c", "d", "e"], 80)).toBe("a, b, c +2 more");
    expect(summarize(["alpha", "beta", "gamma", "delta"], 20)).toBe("alpha, beta +2 more");
    expect(summarize(["alpha", "beta", "gamma", "delta"], 14)).toBe("alpha +3 more");
    expect(summarize(["a".repeat(30), "beta"], 20)).toBe("aaaaaaaaaaa… +1 more");
    expect(summarize([], 20)).toBe("");
  });

  it("wrap breaks a line at word ends inside the width, indents the rest by two, and cuts a word longer than the width", () => {
    expect(wrap("short line", 20)).toEqual(["short line"]);
    expect(wrap("Installs  Claude Code, Codex, 89 tools plus Homebrew's toolchain", 40)).toEqual(["Installs  Claude Code, Codex, 89 tools", "  plus Homebrew's toolchain"]);
    expect(wrap("a".repeat(30), 10)).toEqual(["aaaaaaaaa…"]);
    expect(wrap("  " + "a".repeat(30), 10)).toEqual(["  aaaaaaa…"]);
    expect(wrap("", 10)).toEqual([""]);
    // A line that fits keeps its spacing: the summary indents the sign-ins under their rung and pads its columns with two spaces.
    expect(wrap("  GitHub CLI login  copy", 40)).toEqual(["  GitHub CLI login  copy"]);
    expect(wrap("Upload    77.0 MB, nothing has left this computer yet", 30)).toEqual(["Upload    77.0 MB, nothing has", "  left this computer yet"]);
  });

  it("card prints a bold title on the step glyph and its lines down the bar, an empty line as a bare bar, and long lines wrapped to the width", () => {
    const output = Object.assign(new PassThrough(), { columns: 40 });
    const chunks: string[] = [];
    output.on("data", (c: Buffer) => chunks.push(c.toString()));
    card("Summary", ["Identity  2 of 3  1.7 KB", "  GitHub CLI login  copy", "", "Installs  Claude Code, Codex, 89 tools plus Homebrew's toolchain"], output);
    const raw = chunks.join("");
    const lines = stripVTControlCharacters(raw).split("\n");
    expect(lines).toEqual(["│", "◇  Summary", "│  Identity  2 of 3  1.7 KB", "│    GitHub CLI login  copy", "│", "│  Installs  Claude Code, Codex, 89", "│    tools plus Homebrew's toolchain", ""]);
    expect(lines.map(l => l.length).filter(n => n > 40)).toEqual([]);
    expect(raw).not.toMatch(/[╮╯─├]/);
  });

  it("the focused bar and its end are one cell wide like clack's thin ones, so focus moving never shifts a column; ASCII off a unicode terminal", () => {
    expect([S_BAR_FOCUS, S_BAR_FOCUS_END]).toEqual(unicode ? ["┃", "┗"] : ["|", "+"]);
    expect(S_BAR_FOCUS.length).toBe(1);
    expect(S_BAR_FOCUS_END.length).toBe(1);
  });

  it("colourDepth is 1 off a terminal and when the env says no colour, Node's depth for TERM and COLORTERM otherwise, and FORCE_COLOR wins", () => {
    expect(colourDepth(false, { TERM: "xterm-256color" })).toBe(1);
    expect(colourDepth(true, { TERM: "dumb" })).toBe(1);
    expect(colourDepth(true, { TERM: "xterm-256color", NO_COLOR: "1" })).toBe(1);
    expect(colourDepth(true, { TERM: "xterm" })).toBe(4);
    expect(colourDepth(true, { TERM: "linux" })).toBe(4);
    expect(colourDepth(true, { TERM: "xterm-256color" })).toBe(8);
    expect(colourDepth(true, { TERM: "xterm-256color", COLORTERM: "truecolor" })).toBe(24);
    expect(colourDepth(false, { FORCE_COLOR: "1" })).toBe(4);
    expect(colourDepth(false, { FORCE_COLOR: "3" })).toBe(24);
    expect(colourDepth(false, { FORCE_COLOR: "0" })).toBe(1);
  });

  it("helpLine joins keys and what they do with dot separators: plain at depth 1, keys plain and the rest dim under 256 colours, two greys from 256 colours up", () => {
    const keys = [
      { key: "space", does: "tick" },
      { key: "← →", does: "fold" },
      { key: "esc", does: "back" },
    ];
    const plain = unicode ? "space tick • ← → fold • esc back" : "space tick   ← → fold   esc back";
    expect(helpLine(keys, 1)).toBe(plain);
    const was = process.env["FORCE_COLOR"];
    process.env["FORCE_COLOR"] = "1";
    try {
      const sixteen = helpLine(keys, 4);
      expect(stripVTControlCharacters(sixteen)).toBe(plain);
      expect(sixteen).toContain("space \x1b[2mtick\x1b[22m");
      expect(sixteen).not.toContain("38;5;");
      expect([...sixteen.matchAll(/\x1b\[([0-9;]*)m/g)].map(m => m[1]).every(c => c === "2" || c === "22")).toBe(true);
    } finally {
      if (was === undefined) delete process.env["FORCE_COLOR"];
      else process.env["FORCE_COLOR"] = was;
    }
    for (const depth of [8, 24]) {
      const coloured = helpLine(keys, depth);
      expect(stripVTControlCharacters(coloured)).toBe(plain);
      expect(coloured).toContain("\x1b[38;5;247mspace\x1b[39m");
      expect(coloured).toContain("\x1b[38;5;243mtick\x1b[39m");
      expect(coloured).toContain(unicode ? "\x1b[38;5;243m • \x1b[39m" : "\x1b[38;5;243m   \x1b[39m");
      expect(coloured).not.toContain("\x1b[38;5;247mtick");
    }
  });
});
