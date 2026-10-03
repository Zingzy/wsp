// SPDX-License-Identifier: AGPL-3.0-only
// V8 keeps a bundle's source two bytes a character once one character passes Latin-1 (0.6 MB on the host); the build drops comments, so they are not read.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./source-files.js";

/** Every line of code under the protocol's src, comments taken off, with where it is. */
function codeLines(): { at: string; line: string }[] {
  const dir = join(ROOT, "packages", "protocol", "src");
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(f => f.endsWith(".ts") || f.endsWith(".mts"));
  return files.flatMap(file =>
    readFileSync(join(dir, file), "utf8")
      .split("\n")
      .map((line, i) => ({ at: `${file}:${i + 1}`, line: line.replace(/(^|\s)\/\/.*$/, "") }))
      .filter(({ line }) => !/^\s*(\*|\/\*)/.test(line)),
  );
}

describe("the protocol's own source", () => {
  it("holds no character of its code past Latin-1, so the bundle a host holds is one byte a character", () => {
    expect(codeLines().filter(({ line }) => /[^\x00-\xff]/.test(line)).map(({ at }) => at)).toEqual([]);
  });
});
