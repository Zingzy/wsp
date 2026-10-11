// SPDX-License-Identifier: AGPL-3.0-only
// A project's mark has one drawing: ProjectGlyph, which knows the image, the
// glyph, the hue and the fallback. A file that reads the glyph table itself
// draws a mark that misses the image (the New thread heading and the palette's
// switch rows each did), so only the readers named here, each with its reason,
// may. Read off the sources, so a new reader fails before any screen shows it.
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

const READERS: Record<string, string> = {
  "projects/look.tsx": "the table's home, and ProjectGlyph's own glyph half",
  "projects/LookPicker.tsx": "the Icon select draws every glyph as an option, none of them a project's mark",
  "settings/recipes.tsx": "a recipe's own glyph, picked from the projects' set; a recipe wears no image",
  "settings/computers.tsx": "the glyph of the recipe a computer follows; a recipe wears no image",
  "settings/add/AddComputerDialog.tsx": "the recipes offered to start from and the recipe glyph select; a recipe wears no image",
};

describe("a project's mark", () => {
  it("is drawn by ProjectGlyph alone: only the named readers read the glyph table", () => {
    const readers = sources(SRC)
      .filter(path => /\bPROJECT_GLYPHS\b/.test(readFileSync(path, "utf8")))
      .map(path => relative(SRC, path))
      .sort();
    expect(readers).toEqual(Object.keys(READERS).sort());
  });
});
