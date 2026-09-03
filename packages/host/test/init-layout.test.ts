// SPDX-License-Identifier: AGPL-3.0-only
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ellipsize, fmtDuration, table, widthOf } from "../src/init-layout.js";

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
});
