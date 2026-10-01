// SPDX-License-Identifier: AGPL-3.0-only
// Muted words read at AA on both themes only in the plain muted ink: the same ink at a faded alpha falls under 4.5 on
// Paper and Graphite alike. Read off the sources, so a faded label fails here before any screen shows it. An icon (its
// class sizes it), a glyph hidden from reading, and the graphics named below draw no words and may fade.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Faded muted inks that draw a graphic, not words, each by the class it carries. */
const GRAPHICS = [
  "components/machine/MachineSurface.tsx: text-muted-foreground/40", // a stale chart's line
  "lib/diffRendering.ts: text-muted-foreground/80", // an unclassified file's collapse icon
  "components/chat/ComposerModelPicker.tsx: shrink-0 rounded p-1 text-muted-foreground/60", // the star button's icon
];

describe("muted words", () => {
  it("are set in the plain muted ink, never a faded one", () => {
    const faded = sources(SRC).flatMap(path =>
      readFileSync(path, "utf8")
        .split("\n")
        .filter(line => !/\bsize-|aria-hidden/.test(line))
        .flatMap(line => [...line.matchAll(/["'`]([^"'`]*text-muted-foreground\/\d+[^"'`]*)["'`]/g)].map(([, cls]) => `${relative(SRC, path)}: ${cls}`))
        .filter(found => !GRAPHICS.some(graphic => found.startsWith(graphic))),
    );
    expect(faded).toEqual([]);
  });
});
