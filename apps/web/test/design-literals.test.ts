// SPDX-License-Identifier: AGPL-3.0-only
// Sizes, radii, shadows and colours come from the named scale in index.css and the theme files, never a number typed
// at the site. A literal that is not in ALLOWED fails, and an entry whose count no longer matches fails too, so the
// list only shrinks. Spacing and sizes are held to one count per kind that may only fall.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type Allowed, holdTo } from "../../../packages/protocol/test/allowed.js";
import { sourceStrings } from "./source-strings.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** The files where the scale and the colours are named. */
const SCALE_FILES = /^(index\.css|themes\/[^/]+\.css)$/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });
}

/** An arbitrary value holding a raw number rather than a variable. */
const RAW = String.raw`\[(?![^\]]*var\()[^\]]*\d[^\]]*\]`;
const BANNED: ReadonlyArray<{ kind: string; find: RegExp }> = [
  { kind: "font size", find: /(?<![\w-])text-\[\d+(?:\.\d+)?px\]/g },
  { kind: "line height", find: /(?<![\w-])leading-\[\d+(?:\.\d+)?px\]/g },
  { kind: "radius", find: /(?<![\w-])rounded(?:-[a-z]{1,2})?-\[\d+(?:\.\d+)?px\]/g },
  { kind: "tracking", find: /(?<![\w-])tracking-\[[^\]]*\]/g },
  { kind: "shadow", find: /shadow-\[[^\]]*\d[^\]]*\]/g },
  // A colour built from data has its values cut out of the template, so a blank slot marks it as no literal.
  { kind: "colour", find: /(?<![\w&/-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|oklch)\((?=[^)]*\d)(?!\s*,)(?![^)]*,\s*[,)])[^)]*\)/g },
];
/** Spacing and sizes, counted per kind rather than listed. */
const COUNTED: ReadonlyArray<{ kind: string; find: RegExp }> = [
  { kind: "spacing", find: new RegExp(String.raw`(?<![\w-])-?(?:p[xytblrse]?|m[xytblrse]?|gap(?:-[xy])?|space-[xy]|inset(?:-[xy])?|top|right|bottom|left|start|end)-${RAW}`, "g") },
  { kind: "size", find: new RegExp(String.raw`(?<![\w-])(?:w|h|size|min-w|min-h|max-w|max-h)-${RAW}`, "g") },
];

/** The strings of a source file, where a class or a colour is written; a comment's words are not a literal. */
const strings = (text: string, css: boolean): string[] => (css ? [text.replace(/\/\*[\s\S]*?\*\//g, "")] : sourceStrings(text));

const files = sources(SRC).map(path => ({ file: relative(SRC, path).split("\\").join("/"), path }));
const found = (finds: ReadonlyArray<{ kind: string; find: RegExp }>, skip: RegExp | null) =>
  files
    .filter(({ file }) => skip === null || !skip.test(file))
    .flatMap(({ file, path }) => {
      const css = file.endsWith(".css");
      return strings(readFileSync(path, "utf8"), css).flatMap(s => finds.flatMap(({ kind, find }) => [...s.matchAll(find)].map(([text]) => ({ file, kind, text: text! }))));
    });

const hits = found(BANNED, SCALE_FILES);

const BEFORE = (to: string): string => `before 2026-10-06, move to ${to}`;
/** Every literal the sources may still carry, in whichever file, as many times as count says, each with where it moves. */
const ALLOWED: readonly Allowed[] = [
  { text: "#000", count: 1, why: "a QR code is black on white in every theme, so a camera reads it" },
  { text: "#060606", count: 3, why: BEFORE("a theme token in the dev tuner") },
  { text: "#fff", count: 1, why: "a QR code is black on white in every theme, so a camera reads it" },
  { text: "leading-[14px]", count: 3, why: BEFORE("a named leading") },
  { text: "leading-[18px]", count: 12, why: BEFORE("a named leading") },
  { text: "leading-[20px]", count: 1, why: BEFORE("leading-5") },
  { text: "leading-[22px]", count: 2, why: BEFORE("a named leading") },
  { text: "leading-[28px]", count: 4, why: BEFORE("leading-7") },
  { text: "leading-[38px]", count: 4, why: BEFORE("a named leading") },
  { text: "leading-[48px]", count: 1, why: BEFORE("leading-12") },
  { text: "rgb(0_0_0/10%)", count: 1, why: BEFORE("a theme token") },
  { text: "rgb(0_0_0/18%)", count: 1, why: BEFORE("a theme token") },
  { text: "rgb(14, 18, 24)", count: 1, why: BEFORE("the terminal's theme tokens") },
  { text: "rgb(180, 203, 255)", count: 1, why: BEFORE("the terminal's theme tokens") },
  { text: "rgb(237, 241, 247)", count: 1, why: BEFORE("the terminal's theme tokens") },
  { text: "rgb(255, 255, 255)", count: 1, why: BEFORE("the terminal's theme tokens") },
  { text: "rgb(255_255_255/4%)", count: 1, why: BEFORE("a theme token") },
  { text: "rgb(28, 33, 41)", count: 1, why: BEFORE("the terminal's theme tokens") },
  { text: "rgb(38, 56, 78)", count: 1, why: BEFORE("the terminal's theme tokens") },
  { text: "rgba(0 0 0 / 0)", count: 1, why: BEFORE("the terminal's theme tokens") },
  { text: "rgba(0, 0, 0, 0)", count: 1, why: BEFORE("the terminal's theme tokens") },
  { text: "rgba(180, 203, 255, 0.25)", count: 1, why: BEFORE("the terminal's theme tokens") },
  { text: "rgba(37, 63, 99, 0.2)", count: 1, why: BEFORE("the terminal's theme tokens") },
  { text: "rgba(72, 122, 191, 0.35)", count: 1, why: BEFORE("a theme token") },
  { text: "rounded-[10px]", count: 3, why: BEFORE("a radius on the scale") },
  { text: "rounded-[11px]", count: 4, why: BEFORE("rounded-card") },
  { text: "rounded-[12px]", count: 6, why: BEFORE("rounded-popover") },
  { text: "rounded-[15px]", count: 1, why: BEFORE("a radius on the scale") },
  { text: "rounded-[16px]", count: 1, why: BEFORE("a radius on the scale") },
  { text: "rounded-[20px]", count: 2, why: BEFORE("a radius on the scale") },
  { text: "rounded-[22px]", count: 3, why: BEFORE("rounded-composer") },
  { text: "rounded-[2px]", count: 2, why: BEFORE("a radius on the scale") },
  { text: "rounded-[3px]", count: 3, why: BEFORE("a radius on the scale") },
  { text: "rounded-[4px]", count: 1, why: BEFORE("a radius on the scale") },
  { text: "rounded-[5px]", count: 3, why: BEFORE("a radius on the scale") },
  { text: "rounded-[6px]", count: 1, why: BEFORE("a radius on the scale") },
  { text: "rounded-[7px]", count: 8, why: BEFORE("rounded-field") },
  { text: "rounded-[9px]", count: 2, why: BEFORE("a radius on the scale") },
  { text: "rounded-b-[11px]", count: 1, why: BEFORE("rounded-b-card") },
  { text: "rounded-b-[13px]", count: 1, why: BEFORE("a radius on the scale") },
  { text: "rounded-b-[16px]", count: 1, why: BEFORE("a radius on the scale") },
  { text: "rounded-e-[7px]", count: 1, why: BEFORE("rounded-e-field") },
  { text: "rounded-s-[7px]", count: 1, why: BEFORE("rounded-s-field") },
  { text: "rounded-t-[11px]", count: 1, why: BEFORE("rounded-t-card") },
  { text: "rounded-t-[14px]", count: 1, why: BEFORE("a radius on the scale") },
  { text: "rounded-t-[16px]", count: 1, why: BEFORE("a radius on the scale") },
  { text: "shadow-[0_-1px_--theme(--color-white/2%)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { text: "shadow-[0_-1px_--theme(--color-white/6%)]", count: 8, why: BEFORE("a named shadow in index.css") },
  { text: "shadow-[0_0_0_3px_var(--background)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { text: "shadow-[0_12px_28px_-18px_rgb(0_0_0/40%)]", count: 3, why: BEFORE("shadow-composer") },
  { text: "shadow-[0_14px_32px_-18px_rgb(0_0_0/75%)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { text: "shadow-[0_1px_--theme(--color-black/4%)]", count: 9, why: BEFORE("a named shadow in index.css") },
  { text: "shadow-[0_1px_--theme(--color-black/8%)]", count: 2, why: BEFORE("a named shadow in index.css") },
  { text: "shadow-[0_1px_--theme(--color-white/16%)]", count: 2, why: BEFORE("a named shadow in index.css") },
  { text: "shadow-[0_1px_1px_#0008]", count: 1, why: BEFORE("a named shadow in index.css") },
  { text: "shadow-[0_6px_18px_rgb(0_0_0/6%)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { text: "shadow-[0_8px_20px_-8px_rgb(0_0_0/45%),0_2px_4px_-2px_rgb(0_0_0/30%)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { text: "shadow-[inset_0_0_0_1.5px_currentColor]", count: 1, why: BEFORE("a named shadow in index.css") },
  { text: "shadow-[inset_0_0_0_100vmax_color-mix(in_srgb,var(--primary)_9%,transparent)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { text: "shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { text: "shadow-[inset_0_1px_0_var(--keycap-top)]", count: 2, why: BEFORE("shadow-keycap") },
  { text: "shadow-[inset_0_1px_var(--chat-composer-highlight)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { text: "text-[10px]", count: 2, why: BEFORE("a size on the type scale") },
  { text: "text-[11px]", count: 63, why: BEFORE("text-meta") },
  { text: "text-[12.5px]", count: 8, why: BEFORE("a size on the type scale") },
  { text: "text-[12px]", count: 7, why: BEFORE("text-xs") },
  { text: "text-[13.5px]", count: 5, why: BEFORE("text-head") },
  { text: "text-[13px]", count: 147, why: BEFORE("text-note") },
  { text: "text-[14px]", count: 1, why: BEFORE("text-sm") },
  { text: "text-[15px]", count: 16, why: BEFORE("text-title") },
  { text: "text-[20px]", count: 1, why: BEFORE("a size on the type scale") },
  { text: "text-[26px]", count: 1, why: BEFORE("a size on the type scale") },
  { text: "text-[8px]", count: 2, why: BEFORE("a size on the type scale") },
  { text: "text-[9px]", count: 2, why: BEFORE("a size on the type scale") },
  { text: "tracking-[-0.01em]", count: 3, why: BEFORE("a named tracking for the display title") },
  { text: "tracking-[0.04em]", count: 1, why: BEFORE("a named tracking for a device code") },
];

/** How many of each counted kind the sources hold now. A new one fails; one taken away fails until the figure here
 * falls with it. */
const CEILINGS: Readonly<Record<string, number>> = { spacing: 107, size: 139 };

describe("sizes, radii, shadows and colours come from the named scale", () => {
  const held = holdTo(hits.map(hit => ({ text: hit.text, where: hit.file })), ALLOWED);

  it("finds no literal beyond the allowed list", () => {
    expect([...held.refused, ...held.over]).toEqual([]);
  });

  it("keeps no allowed count above what the sources hold", () => {
    expect(held.stale).toEqual([]);
  });

  it("holds spacing and sizes at their ceilings", () => {
    const counted = found(COUNTED, null);
    const counts = Object.fromEntries(Object.keys(CEILINGS).map(kind => [kind, counted.filter(hit => hit.kind === kind).length]));
    expect(counts).toEqual(CEILINGS);
  });
});
