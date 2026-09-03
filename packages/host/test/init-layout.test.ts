// SPDX-License-Identifier: AGPL-3.0-only
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ellipsize, fmtDuration, rowsOf, summarize, table, viewport, widthOf } from "../src/init-layout.js";

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
});
