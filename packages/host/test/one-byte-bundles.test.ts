// SPDX-License-Identifier: AGPL-3.0-only
// V8 keeps a script's source two bytes a character once one character passes Latin-1, for as long as the host
// runs, so each bundle the host loads is held to Latin-1: esbuild escapes every string, a regular expression it
// leaves as written, and one character there doubled the host chunk (about 0.9 MB on the memory test).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { describeWithDists, distOf } from "./built-bin.js";

const PACKAGES = ["protocol", "catalog", "collect", "engine", "runtime", "keys", "own-file", "host"] as const;

/** Every file a package's entry loads, its chunks followed by their own relative imports. */
function loaded(entry: string): string[] {
  const seen = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, rel] of readFileSync(file, "utf8").matchAll(/(?:from|import)\s*["'](\.\/[^"']+\.js)["']/g)) walk(join(dirname(file), rel!));
  };
  walk(entry);
  return [...seen];
}

describeWithDists("the bundles the host loads", PACKAGES, () => {
  it("hold no character past Latin-1, so each is kept one byte a character", () => {
    const wide = PACKAGES.flatMap(pkg =>
      loaded(fileURLToPath(distOf(pkg))).flatMap(file => {
        const text = readFileSync(file, "utf8");
        const at = [...text].findIndex(c => c.codePointAt(0)! > 0xff);
        return at === -1 ? [] : [`${file}: ${JSON.stringify(text.slice(Math.max(0, at - 40), at + 10))}`];
      }),
    );
    expect(wide).toEqual([]);
  });
});
