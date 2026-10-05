// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
/** The app, the desktop shell, the command line's own launcher and every package: the command line prints from all of them. */
const SCANNED = [
  "apps/web/src",
  "apps/desktop/src",
  "apps/wspx/src",
  ...readdirSync(join(ROOT, "packages"), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(ROOT, "packages", entry.name, "src")))
    .map(entry => `packages/${entry.name}/src`),
];

/** A middle dot, a bullet and their look-alikes, as the glyph, its escape or its HTML entity. */
const DOT = /[·•∙⋅‧・]|\\u(?:00b7|2022|2219|22c5|2027|30fb)|&(?:middot|bull);/i;

/** Every dot the sources may still carry, each with why it is no separator between two pieces of text. */
const ALLOWED: ReadonlyArray<{ file: string; text: string; why: string }> = [
  { file: "apps/web/src/settings/recipe/RecipeScreen.tsx", text: '"••••••••"', why: "the masked placeholder of a key already saved" },
  { file: "packages/protocol/src/format.ts", text: 'NEEDS_YOU_MARK = "\\u2022 "', why: "a mark leading the window title while a need stands, with no text before it" },
  { file: "packages/host/src/init-select.ts", text: 'dim("•")', why: "the glyph leading a row that always comes along, in the column where other rows carry their box" },
  { file: "packages/host/src/places.ts", text: 'l.state === "done" ? "·"', why: "the mark leading an add's or a setup's step that is done, in the column where a failed one carries x" },
  { file: "apps/web/src/slate/approvals.tsx", text: "/^•+/.test(value)", why: "whether a value is a set secret's mask, the dots the host sends in place of it" },
  { file: "apps/web/src/slate/consent.tsx", text: "/^•+/.test(value)", why: "whether a value is a set secret's mask, the dots the host sends in place of it" },
  { file: "apps/web/src/slate/mcp.tsx", text: "/^•+/.test(value)", why: "whether a value is a set secret's mask, the dots the host sends in place of it" },
  { file: "apps/web/src/slate/pieces/input.tsx", text: '"•".repeat(', why: "a set secret's mask, the dots shown in place of its value" },
  { file: "packages/protocol/src/slate/catalog.ts", text: "never by ·, • or |", why: "the catalog's rule telling an agent never to separate things with a dot" },
  { file: "packages/protocol/src/slate/kit.ts", text: "${label}: ••••", why: "a set secret's mask, the dots shown in place of its value" },
  { file: "packages/protocol/src/slate/sketch.ts", text: 'SECRET_DOTS = "••••"', why: "a set secret's mask, the dots shown in place of its value" },
  { file: "packages/protocol/src/slate/validate.ts", text: "([·\\u2022])", why: "the slate's own rule refusing a dot between two pieces of text" },
  { file: "packages/runtime/src/slate-mcp.ts", text: 'DOTS = "••••"', why: "a set secret's mask, the dots shown in place of its value" },
  { file: "packages/runtime/src/slate-runs.ts", text: 'DOTS = "••••"', why: "a set secret's mask, the dots shown in place of its value" },
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const hits = SCANNED.flatMap(dir =>
  sources(join(ROOT, dir)).flatMap(path =>
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line, at) => (DOT.test(line) ? [{ file: relative(ROOT, path), line: at + 1, text: line.trim() }] : [])),
  ),
);

describe("no dot between two pieces of text", () => {
  it("finds no middle dot or bullet in the app's, the command line's or any package's sources beyond the allowed list", () => {
    const loose = hits.filter(hit => !ALLOWED.some(ok => ok.file === hit.file && hit.text.includes(ok.text)));
    expect(loose.map(hit => `${hit.file}:${hit.line}: ${hit.text}`)).toEqual([]);
  });

  it("keeps no allowed entry that no longer matches a line", () => {
    const stale = ALLOWED.filter(ok => !hits.some(hit => hit.file === ok.file && hit.text.includes(ok.text)));
    expect(stale).toEqual([]);
  });
});
