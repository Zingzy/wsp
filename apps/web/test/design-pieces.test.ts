// SPDX-License-Identifier: AGPL-3.0-only
// A screen is built from the shared pieces, never drawn beside them. Read off the sources, so a card, a glyph frame,
// a head, a grid, a status dot or a keycap drawn by hand fails here before any screen shows it. A hit that is not
// in ALLOWED fails, and an ALLOWED entry that no longer meets its hits fails too, so the list only shrinks.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type Allowed, holdTo } from "../../../packages/protocol/test/allowed.js";
import { sourceStrings } from "./source-strings.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** The files that define the pieces, which spell out what every other file imports. */
const PIECES = [/^settings\/(layout\.ts|rows\.tsx|grid\.tsx|format\.ts|sheetParts\.tsx)$/, /^settings\/add\/(PickRow|StepRow|StepDialog)\.tsx$/, /^components\/(ui|status)\//, /^lib\/microLabel\.ts$/];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });
}

/** A JSX element's opening tag from its `<`, read past braces and quotes so a `>` inside a class or an arrow does not
 * end it. */
function openingTag(text: string, at: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = at + 1; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return text.slice(at, i + 1);
  }
  return text.slice(at);
}

const tokens = (classes: string): string[] => classes.split(/\s+/).filter(Boolean);
const has = (classes: string, test: RegExp): boolean => tokens(classes).some(token => test.test(token));
const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

interface Ban {
  readonly why: string;
  /** Every hit in one file's text, each as the text it matched. */
  readonly find: (text: string, file: string) => string[];
}

const classStrings = (text: string): string[] => sourceStrings(text).map(squash);
const classBan = (why: string, test: (classes: string, file: string) => boolean): Ban => ({ why, find: (text, file) => classStrings(text).filter(s => test(s, file)) });
const tagBan = (why: string, tag: RegExp, test: (open: string) => boolean): Ban => ({
  why,
  find: text => [...text.matchAll(tag)].map(m => squash(openingTag(text, m.index))).filter(test),
});

/** The names the pieces export, which a file of its own never declares again. */
const SHARED_NAMES = ["NOTE", "QUIET", "ROW", "GLYPH", "CARD_PAD", "FACT", "VALUE", "LIST_TITLE", "SETTING_TITLE", "SECTION_HEAD", "GROUP_LABEL", "CARD_SURFACE", "CARD_INSET", "ROW_FLOOR", "LINE_FLOOR", "GLYPH_FRAME"];

const BANS: readonly Ban[] = [
  classBan("a card surface by hand: use Card or CARD_SURFACE", s => has(s, /^rounded(-|$)/) && has(s, /^border$/) && has(s, /^bg-card(\/|$)/)),
  classBan("a glyph frame by hand: use GLYPH_FRAME", s => has(s, /^size-8$/) && has(s, /^rounded-md$/) && has(s, /^border$/)),
  tagBan("a head by hand: use SECTION_HEAD, GROUP_LABEL or DialogTitle", /<h[23]\b/g, open => !/\b(SECTION_HEAD|GROUP_LABEL)\b/.test(open)),
  classBan("a grid by hand in Settings: use LIST_COLUMNS or PAGE_COLUMNS", (s, file) => file.startsWith("settings/") && s.includes("grid-cols-[")),
  classBan("a status dot: use StateMark or the word alone", s => has(s, /^rounded-full$/) && has(s, /^size-(1|1\.5|2)$/) && has(s, /^bg-/)),
  tagBan("a keycap outside KeyCaps, the Keybindings page and a tooltip", /<Kbd\b/g, () => true),
  classBan("a dashed edge, a pattern of no wsp screen", s => has(s, /(^|:)border-dashed$/)),
  classBan("a dot grid, a pattern of no wsp screen", s => s.includes("bg-[radial-gradient(")),
  tagBan("a button drawn by hand: use Button, or a Row with open", /<button\b/g, open => {
    const classes = (/className=(?:"[^"]*"|\{[^}]*\})/.exec(open)?.[0] ?? "").replace(/[{}"`(),]/g, " ");
    return has(classes, /^(h|py)-/) && has(classes, /^rounded(-|$)/) && has(classes, /^border$/);
  }),
  tagBan("a dialog at a width of its own: use DialogPopup's own width", /<DialogPopup\b/g, open => open.includes("max-w-[")),
  {
    why: "a local constant shadowing a shared piece: import the shared one",
    find: text => [...text.matchAll(new RegExp(`\\bconst (${SHARED_NAMES.join("|")})\\s*[=:]`, "g"))].map(m => `const ${m[1]}`),
  },
];

/** Every hand-drawn piece the sources may still carry, in whichever file, as many times as count says, each with the
 * piece it moves to. A hit is read by its first 80 characters, cut at a space, or hard at 80 where none is. */
const BEFORE = (piece: string): string => `before 2026-10-06, move to ${piece}`;
const ALLOWED: readonly Allowed[] = [
  { text: "-end-1.5 -top-1.5 absolute size-5 rounded-full border border-border/60 bg-card", count: 1, why: BEFORE("Button") },
  { text: "<DialogPopup className=\"w-auto max-w-[90vw] p-2\">", count: 1, why: BEFORE("a named DialogPopup width") },
  { text: "<DialogPopup ref={popup} initialFocus={popup} data-slate-diagram-expanded", count: 1, why: BEFORE("a named DialogPopup width") },
  { text: "<Kbd className=\"h-6 min-w-0 rounded-md px-1.5 font-mono text-xs\">", count: 1, why: BEFORE("a tooltip") },
  { text: "<Kbd className=\"mr-auto h-auto rounded border border-border bg-transparent", count: 1, why: BEFORE("a tooltip") },
  { text: "<Kbd className=\"ms-auto font-sans\">", count: 1, why: BEFORE("MenuShortcut") },
  { text: "<Kbd className={head}>", count: 1, why: BEFORE("a tooltip") },
  { text: "<Kbd>", count: 13, why: BEFORE("a tooltip, or the pieces page in the gallery") },
  { text: "<button type=\"button\" data-scroll-to-end aria-hidden={hidden || undefined}", count: 1, why: BEFORE("Button") },
  { text: "<button type=\"button\" data-slot=\"composer-banner-peek\" className={cn(", count: 1, why: BEFORE("Button") },
  { text: "<button type=\"button\" disabled={disabled} onClick={onPress}", count: 1, why: BEFORE("Button") },
  { text: "<button type=\"button\" onClick={copy} className=\"inline-flex h-8 flex-1", count: 1, why: BEFORE("Button") },
  { text: "<button type=\"button\" onClick={reset} className=\"inline-flex h-8 items-center", count: 1, why: BEFORE("Button") },
  { text: "<button type=\"submit\" className={cn( \"relative isolate flex h-9 items-center", count: 1, why: BEFORE("Button") },
  { text: "<h2 className=\"min-w-0 flex-1 truncate text-[13px] leading-5 font-normal", count: 1, why: BEFORE("SECTION_HEAD") },
  { text: "<h2 className={HEADING}>", count: 2, why: BEFORE("Empty") },
  { text: "<h2 data-k=\"ready-title\" className=\"mt-5 text-2xl/8 font-medium", count: 1, why: BEFORE("DialogTitle") },
  { text: "<h2 data-pr-title className=\"text-[15px] leading-[22px] font-medium text-pretty", count: 1, why: BEFORE("HeadRow") },
  { text: "<h2 id={`gallery-${id}`} className=\"text-muted-foreground mb-3 font-mono", count: 1, why: BEFORE("GROUP_LABEL") },
  { text: "<h3 className=\"font-medium text-foreground text-sm\">", count: 1, why: BEFORE("SECTION_HEAD") },
  { text: "<h3 className=\"text-[13px] text-muted-foreground\">", count: 1, why: BEFORE("SECTION_HEAD") },
  { text: "<h3 data-k={`${root}-title`} className=\"text-sm leading-5 font-medium", count: 1, why: BEFORE("SECTION_HEAD") },
  { text: "absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current", count: 2, why: BEFORE("StateMark") },
  { text: "absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current ring-2", count: 1, why: BEFORE("StateMark") },
  { text: "bg-card min-w-0 rounded-lg border p-4", count: 1, why: BEFORE("Card") },
  { text: "block size-1.5 rounded-full bg-border", count: 1, why: BEFORE("StateMark") },
  { text: "block size-1.5 rounded-full bg-muted-foreground", count: 1, why: BEFORE("StateMark") },
  { text: "block size-14 overflow-hidden rounded-lg border border-border/60 bg-card/50", count: 1, why: BEFORE("Card") },
  { text: "const CARD_PAD", count: 1, why: BEFORE("CARD_INSET") },
  { text: "const GLYPH", count: 2, why: BEFORE("GLYPH") },
  { text: "const NOTE", count: 2, why: BEFORE("NOTE") },
  { text: "const QUIET", count: 2, why: BEFORE("NOTE") },
  { text: "const ROW", count: 5, why: BEFORE("Row") },
  { text: "flex cursor-pointer flex-col justify-center gap-3 py-3 sm:grid", count: 1, why: BEFORE("a column set in grid.tsx") },
  { text: "flex h-14 max-w-48 items-center gap-2 rounded-lg border border-border/60", count: 1, why: BEFORE("Card") },
  { text: "grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 gap-y-3", count: 1, why: BEFORE("a column set in grid.tsx") },
  { text: "grid grid-cols-[5.5rem_minmax(0,1fr)_3rem_minmax(0,10rem)] items-center gap-x-4", count: 1, why: BEFORE("a column set in grid.tsx") },
  { text: "grid grid-cols-[auto_minmax(0,1fr)] gap-y-3", count: 1, why: BEFORE("a column set in grid.tsx") },
  { text: "grid grid-cols-[minmax(0,1fr)_104px_96px_120px] gap-x-6", count: 1, why: BEFORE("a column set in grid.tsx") },
  { text: "grid grid-cols-[minmax(0,1fr)_104px_96px_80px_120px] gap-x-6", count: 1, why: BEFORE("a column set in grid.tsx") },
  { text: "grid grid-cols-[minmax(11rem,14rem)_minmax(0,1fr)] items-center gap-x-10 py-4", count: 1, why: BEFORE("a column set in grid.tsx") },
  { text: "grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3 max-sm:grid-cols-2", count: 1, why: BEFORE("a column set in grid.tsx") },
  { text: "grid-cols-[minmax(0,1fr)_140px_14px] max-md:grid-cols-[minmax(0,1fr)_auto_14px]", count: 1, why: BEFORE("a column set in grid.tsx") },
  { text: "max-h-[480px] min-h-[168px] overflow-y-auto rounded-lg border border-border", count: 1, why: BEFORE("Card") },
  { text: "mt-1.5 mb-1 overflow-clip rounded-lg border border-border bg-card", count: 1, why: BEFORE("Card") },
  { text: "mt-2.5 overflow-hidden rounded-lg border border-border bg-card", count: 1, why: BEFORE("Card") },
  { text: "overflow-hidden rounded-[10px] border border-border bg-card", count: 1, why: BEFORE("Card") },
  { text: "pointer-events-none absolute inset-x-0 top-0 -z-10 h-1/2", count: 1, why: BEFORE("a named wash in index.css") },
  { text: "relative flex flex-col gap-0.5 overflow-hidden rounded-[5px] border", count: 1, why: BEFORE("Card") },
  { text: "rounded-xl border border-border/80 bg-card/70 p-4 sm:p-5", count: 1, why: BEFORE("Card") },
  { text: "size-1.5 flex-none rounded-full bg-current", count: 1, why: BEFORE("StateMark") },
  { text: "size-2 rounded-full bg-foreground", count: 2, why: BEFORE("StateMark") },
];

function cut(text: string): string {
  if (text.length <= 80) return text;
  const at = text.lastIndexOf(" ", 80);
  return at > 0 ? text.slice(0, at) : text.slice(0, 80);
}

const hits = sources(SRC).flatMap(path => {
  const file = relative(SRC, path).split("\\").join("/");
  if (PIECES.some(piece => piece.test(file))) return [];
  const text = readFileSync(path, "utf8");
  return BANS.flatMap(ban => ban.find(text, file).map(found => ({ text: cut(found), where: `${file}: ${ban.why}` })));
});

describe("screens are built from the shared pieces", () => {
  const held = holdTo(hits, ALLOWED);

  it("reads a hit by its first 80 characters, cut at a space, or hard at 80 where none is", () => {
    expect(cut(`${"a".repeat(70)} ${"b".repeat(30)}`)).toBe("a".repeat(70));
    expect(cut("grid-cols-[" + "x".repeat(89))).toBe(("grid-cols-[" + "x".repeat(89)).slice(0, 80));
  });

  it("finds no piece drawn by hand beyond the allowed list", () => {
    expect([...held.refused, ...held.over]).toEqual([]);
  });

  it("keeps no allowed entry that no longer meets a hit", () => {
    expect(held.stale).toEqual([]);
  });
});
