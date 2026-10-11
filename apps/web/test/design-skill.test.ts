// SPDX-License-Identifier: AGPL-3.0-only
// The design skill names the pieces and the code holds their figures. Every piece the skill names in backticks is
// exported from apps/web/src, and a px figure written just after a piece's name is one the piece's classes draw, so
// changing a piece without the skill, or the skill without the piece, fails here.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_DIR = join(WEB, "..", "..", ".claude", "skills", "wsp-design");
const SKILL = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}
const SOURCE = sources(join(WEB, "src")).map(path => readFileSync(path, "utf8"));

/** The section that names the pieces, where every name in backticks is one; elsewhere a capitalised word in backticks
 * may be a state word. */
const PIECES_SECTION = /\n## The Settings pieces\n[\s\S]*?(?=\n## )/.exec(SKILL)?.[0] ?? "";
const backticked = (text: string, name: RegExp): string[] => [...text.matchAll(new RegExp(`\`(${name.source})\``, "g"))].map(([, found]) => found!);
/** Every constant in caps the skill names (`CARD_INSET`, `NOTE`), and every component the pieces section names (`Card`). */
const NAMED = [...new Set([...backticked(SKILL, /[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[A-Z]{3,}/), ...backticked(PIECES_SECTION, /[A-Z][a-z]+(?:[A-Z][a-z]*)*/)])];

const exported = (name: string): boolean => SOURCE.some(text => new RegExp(`export\\s+(?:const|function|class|let)\\s+${name}\\b`).test(text) || new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(text));

/** A constant's class string as its source writes it, where it is a string literal. */
const valueOf = (name: string): string | undefined => {
  for (const text of SOURCE) {
    const found = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*"([^"]*)"`).exec(text);
    if (found) return found[1];
  }
  return undefined;
};

const NAMED_SIZES: Record<string, number> = { "text-xs": 12, "text-sm": 14, "text-base": 16, "text-lg": 18, "rounded-sm": 6, "rounded-md": 8, "rounded-lg": 10, "rounded-xl": 14 };
/** Every px figure a class string draws: its arbitrary values, its spacing steps at 4 px, its named sizes. */
const figuresOf = (classes: string): number[] =>
  classes.split(/\s+/).flatMap(token => {
    const bare = token.slice(token.lastIndexOf(":") + 1);
    const literal = [...bare.matchAll(/(\d+(?:\.\d+)?)px/g)].map(([, n]) => Number(n));
    const step = /^-?(?:size|w|h|min-w|min-h|max-w|max-h|p[xytblrse]?|m[xytblrse]?|gap(?:-[xy])?|leading)-(\d+(?:\.\d+)?)$/.exec(bare);
    return [...literal, ...(step ? [Number(step[1]) * 4] : []), ...(bare in NAMED_SIZES ? [NAMED_SIZES[bare]!] : [])];
  });

/** A px figure written just after a name, before another backtick or the sentence's end: `CARD_INSET` (20 px). */
const BESIDE = /`([A-Z][A-Z0-9_]+)`[^`.\n]{0,12}?(\d+(?:\.\d+)?) ?px/g;
const besides = [...SKILL.matchAll(BESIDE)].map(([, name, px]) => ({ name: name!, px: Number(px) }));
/** The px figures the pieces section writes with no constant before them, code spans aside. */
const loose = [...PIECES_SECTION.replace(BESIDE, "").replace(/`[^`\n]*`/g, "").matchAll(/\d+(?:\.\d+)? ?px/g)].map(([figure]) => figure);

describe("the design skill names what the code holds", () => {
  it("names pieces", () => {
    expect(PIECES_SECTION).not.toBe("");
    expect(NAMED.length).toBeGreaterThan(20);
  });

  it("every reference render it lists is a file beside it, the sidebar's kept top among them", () => {
    const listed = [...SKILL.matchAll(/`(references\/[^`]+\.png)`/g)].map(([, path]) => path!);
    expect(listed).toContain("references/sidebar-top-graphite.png");
    expect(listed.filter(path => !existsSync(join(SKILL_DIR, path)))).toEqual([]);
  });

  it("keeps the sidebar's top with the New thread row first", () => {
    expect(SKILL).toMatch(/the sidebar's top: the New thread row[^.]*, the search row, the project picker/);
  });

  it("every piece it names is exported from the app", () => {
    expect(NAMED.filter(name => !exported(name))).toEqual([]);
  });

  it("every figure the pieces section writes stands beside the constant that holds it", () => {
    expect(loose).toEqual([]);
  });

  it("every figure written beside a constant is one the constant draws", () => {
    expect(besides.length).toBeGreaterThan(0);
    const wrong = besides.flatMap(({ name, px }) => {
      const value = valueOf(name);
      if (value === undefined) return [`${name}: no string literal to read ${px} px off`];
      return figuresOf(value).includes(px) ? [] : [`${name}: the skill says ${px} px, the code draws ${figuresOf(value).join(", ") || "no figure"}`];
    });
    expect(wrong).toEqual([]);
  });
});
