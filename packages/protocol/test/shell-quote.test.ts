// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { shellQuote } from "../src/index.js";
import { ROOT, sourceFiles } from "./source-files.js";

const TABLE: [string, string][] = [
  ["", "''"],
  ["plain", "'plain'"],
  ["don't", String.raw`'don'\''t'`],
  ["'", String.raw`''\'''`],
  ["''", String.raw`''\'''\'''`],
  ["a\nb", "'a\nb'"],
  ["-n", "'-n'"],
  ["--flag=x", "'--flag=x'"],
  ["héllo wörld ✓", "'héllo wörld ✓'"],
  ["$HOME `id` $(reboot)", "'$HOME `id` $(reboot)'"],
  ["back\\slash", "'back\\slash'"],
  ["a b\tc", "'a b\tc'"],
  ['say "hi"', `'say "hi"'`],
  ["semi; and && or ||", "'semi; and && or ||'"],
];

describe("shellQuote", () => {
  it.each(TABLE)("quotes %j as one sh word", (input, quoted) => {
    expect(shellQuote(input)).toBe(quoted);
  });

  it.each(TABLE)("sh reads %j back byte for byte", input => {
    const out = execFileSync("/bin/sh", ["-c", `printf '%s' ${shellQuote(input)}`], { encoding: "utf8" });
    expect(out).toBe(input);
  });

  it("several words survive as separate argv entries", () => {
    const argv = ["don't", "", "-n", "$x y"];
    const out = execFileSync("/bin/sh", ["-c", `printf '%s\\n' ${argv.map(shellQuote).join(" ")}`], { encoding: "utf8" });
    expect(out).toBe("don't\n\n-n\n$x y\n");
  });
});

describe("one copy of the rule", () => {
  const HOME = join("packages", "protocol", "src", "shell-quote.ts");
  // Both POSIX spellings of an embedded quote: close, backslash-quote, reopen; and close, double-quoted quote, reopen.
  const RULE = /'\\\\''|String\.raw`'\\''`|'\\?"\\?'\\?"\\?'/;

  it("no other source file spells out the '\\'' rule", () => {
    const copies = sourceFiles().filter(rel => rel !== HOME && RULE.test(readFileSync(join(ROOT, rel), "utf8")));
    expect(copies).toEqual([]);
  });
});
