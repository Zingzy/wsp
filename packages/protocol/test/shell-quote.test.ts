// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shellQuote } from "../src/index.js";

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
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  // The daemon must not bundle this package, so it keeps its own copy; its test pins the two equal.
  const KEPT = new Set([join("packages", "protocol", "src", "shell-quote.ts"), join("packages", "daemon", "src", "manifest.ts")]);
  const RULE = /'\\\\''|String\.raw`'\\''`/;

  it("no other source file spells out the '\\'' rule", () => {
    const copies: string[] = [];
    for (const top of ["packages", "apps"]) {
      for (const pkg of readdirSync(join(root, top), { withFileTypes: true })) {
        if (!pkg.isDirectory()) continue;
        const src = join(root, top, pkg.name, "src");
        let files: string[];
        try {
          files = readdirSync(src, { recursive: true, encoding: "utf8" });
        } catch {
          continue;
        }
        for (const f of files) {
          if (!/\.tsx?$/.test(f) || /\.test\.tsx?$/.test(f)) continue;
          const rel = join(top, pkg.name, "src", f);
          if (KEPT.has(rel)) continue;
          if (RULE.test(readFileSync(join(root, rel), "utf8"))) copies.push(rel);
        }
      }
    }
    expect(copies).toEqual([]);
  });
});
