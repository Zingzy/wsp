// SPDX-License-Identifier: AGPL-3.0-only
// The owner's ruling of 2026-09-28: every group heading is sentence case in sans, T3's style, never the caps mono
// label. Read off the sources, so a heading that brings the caps back fails here before any screen shows it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as labels from "../src/lib/microLabel.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Letter-spacing that sets a code apart for reading, never a label: the pairing sketch's masked code and a device
 * sign-in code. */
const CODES = ["settings/AddComputer.tsx: rounded-[4px]", "settings/recipe/BuildRows.tsx: shrink-0 whitespace-nowrap font-mono text-[20px]"];

describe("group headings", () => {
  it("no class in the app spells caps or any letter-spacing wider than normal", () => {
    const caps = sources(SRC).flatMap(path =>
      [...readFileSync(path, "utf8").matchAll(/["'`]([^"'`\n]*)["'`]/g)]
        .filter(([, text]) => /(^|\s|:)(uppercase|tracking-wide(r|st)?|tracking-\[[^\]-][^\]]*\])(\s|$)/.test(text!))
        .map(([, text]) => `${relative(SRC, path)}: ${text}`)
        .filter(found => !CODES.some(code => found.startsWith(code))),
    );
    expect(caps).toEqual([]);
  });

  it("the caps label is gone and the one group heading is sentence case in sans", () => {
    expect(Object.keys(labels)).toEqual(["GROUP_LABEL"]);
    expect(labels.GROUP_LABEL).not.toMatch(/uppercase|font-mono|tracking/);
  });
});
