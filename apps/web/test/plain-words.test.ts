// SPDX-License-Identifier: AGPL-3.0-only
// No sentence the app shows says an internal word: the daemon, the helper, or a link's close code in parentheses. A
// sentence is a string literal with a space in it; comments, logs and the palette's search terms, which nobody
// reads, are left out.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { absentComputer, ownDaemonDown } from "@wsp/protocol";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "../src");
const LITERAL = /(["'`])((?:\\.|(?!\1).)*?)\1/g;
const INTERNAL = /\bdaemons?\b|\bhelper\b|\(\d{4}\)/i;
/** The one place the word stands: which daemon a computer runs, as a version fact under its name on Computers, which
 * the owner asked each computer's row to say. Exact, so any sentence that says it still fails. */
const VERSION_FACT = "daemon ${daemon}";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

describe("the words the app shows", () => {
  it("never say daemon, helper or a close code", () => {
    const found = sources(SRC).flatMap(path =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, n) => {
          const code = line.trim();
          if (/^(\/\/|\*|\/\*)/.test(code) || code.includes("console.") || code.includes("searchTerms")) return [];
          return [...line.matchAll(LITERAL)].map(m => m[2]!).filter(said => said.includes(" ") && INTERNAL.test(said) && said !== VERSION_FACT).map(said => `${relative(SRC, path)}:${n + 1}: ${said}`);
        }),
    );
    expect(found).toEqual([]);
  });

  it("never say them when a computer, or this one's own terminals and files, stop answering", () => {
    const readings = [ownDaemonDown("zingzy's MacBook Pro"), absentComputer("spoo", 90_000)];
    for (const reading of readings) for (const said of Object.values(reading)) expect(String(said)).not.toMatch(INTERNAL);
  });
});
