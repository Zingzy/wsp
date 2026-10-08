// SPDX-License-Identifier: AGPL-3.0-only
// The app's built CSS holds no :has() that styles past its own element. Chrome cannot narrow which elements a rule
// like `:where(.group):has(x) *` reaches, so any change under such a group restyles every descendant of every
// ancestor of the change, and a :has() on html restyles the page: a keystroke in the composer cost 135 to 163 ms of
// style over 10,833 elements, and 1 ms with every :has() rule taken out. The component that knows the fact
// sets a data attribute instead. A :has() deciding only its own element's style may stay, each one named below.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type Allowed, holdTo } from "../../../packages/protocol/test/allowed.js";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(WEB, "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Every stylesheet the app's sources import, each resolved where its importer would find it. */
function stylesheets(): string[] {
  const found = new Set([join(SRC, "index.css")]);
  for (const file of sources(SRC)) {
    for (const [, spec] of readFileSync(file, "utf8").matchAll(/^import\s+["']([^"']+\.css)["'];?$/gm)) {
      found.add(spec!.startsWith(".") ? resolve(dirname(file), spec!) : createRequire(file).resolve(spec!));
    }
  }
  return [...found];
}

/** The CSS a production build of the app's stylesheets writes, with one more class scanned when extra names it. */
const builtCss = (extra?: string): string =>
  execFileSync(process.execPath, [join(WEB, "test", "built-css.mjs"), ...(extra === undefined ? [] : ["--extra", extra]), ...stylesheets()], {
    cwd: WEB,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });

/** Splits at the top level of a selector, outside brackets, parentheses and quotes, wherever `at` says. */
function splitTop(text: string, at: (text: string, i: number) => number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== "") {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0) {
      const width = at(text, i);
      if (width > 0) {
        parts.push(text.slice(start, i));
        start = i + width;
        i = start - 1;
      }
    }
  }
  parts.push(text.slice(start));
  return parts.map(p => p.trim()).filter(p => p !== "");
}

const commas = (list: string): string[] => splitTop(list, (t, i) => (t[i] === "," ? 1 : 0));
/** A complex selector's compounds, cut at its combinators: whitespace, >, + and ~. */
const compounds = (complex: string): string[] =>
  splitTop(complex, (t, i) => {
    const m = /^\s*[>+~]\s*|^\s+/.exec(t.slice(i));
    return m === null ? 0 : m[0].length;
  });

/** The selector lists inside a compound's :is(), :where() and :not(); a :has()'s own argument is its subject's. */
function innerLists(compound: string): string[] {
  const lists: string[] = [];
  for (const m of compound.matchAll(/:(is|where|not)\(/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < compound.length && depth > 0; i++) {
      if (compound[i] === "\\") i++;
      else if (compound[i] === "(") depth++;
      else if (compound[i] === ")") depth--;
    }
    lists.push(compound.slice(start, i - 1));
  }
  return lists;
}

/** Why a selector list breaks the law, one line per complex selector that does. */
function broken(list: string): string[] {
  return commas(list).flatMap(complex => {
    const parts = compounds(complex);
    const own = parts.flatMap((part, i) => {
      if (!part.includes(":has(")) return [];
      if (/^(html|body|:root)\b/.test(part)) return [`a :has() on the document's root: ${complex}`];
      return i < parts.length - 1 ? [`a :has() styling past its own element: ${complex}`] : [];
    });
    return [...own, ...parts.flatMap(part => innerLists(part).flatMap(broken))];
  });
}

/** Every rule's selector list in a stylesheet, at-rules and keyframe steps left out. */
function selectorLists(css: string): string[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...bare.matchAll(/([^{};]+)\{/g)].map(m => m[1]!.trim()).filter(s => s !== "" && !s.startsWith("@") && !/^(from|to|\d[\d.]*%)$/.test(s));
}

/** Each :has() a selector holds, as written in the built CSS, which is what the survivors below are named by. */
const hasCalls = (selector: string): string[] => {
  const calls: string[] = [];
  for (const m of selector.matchAll(/:has\(/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < selector.length && depth > 0; i++) {
      if (selector[i] === "(") depth++;
      else if (selector[i] === ")") depth--;
    }
    calls.push(selector.slice(m.index, i));
  }
  return calls;
};

const OWN = "decides its own element alone, from what it holds";
/** Each :has() left, how many selectors of the built CSS hold it, and why it stays. */
const SURVIVORS: readonly Allowed[] = [
  { text: ':has([aria-invalid="true"])', count: 6, why: `an input's or a number field's frame reddens around an invalid control: ${OWN}` },
  { text: ":has(:focus-visible)", count: 4, why: `an input's frame takes the ring while its control has focus: ${OWN}` },
  { text: ":has(:autofill)", count: 4, why: `an input's frame tints under the browser's autofill: ${OWN}` },
  { text: ":has(:disabled)", count: 1, why: `an input's frame fades with a disabled control: ${OWN}` },
  { text: ":has(:is(textarea))", count: 1, why: `an input group with a textarea grows to it: ${OWN}` },
  { text: ":has(:is(input:focus-visible, textarea:focus-visible))", count: 4, why: `an input group takes the ring while its control has focus: ${OWN}` },
  { text: ":has(:is(input[aria-invalid], textarea[aria-invalid]))", count: 4, why: `an input group reddens around an invalid control: ${OWN}` },
  { text: ":has(:is(input:disabled, textarea:disabled))", count: 1, why: `an input group fades with a disabled control: ${OWN}` },
  { text: ":has(:is(input:disabled, textarea:disabled, input:focus-visible, textarea:focus-visible, input[aria-invalid], textarea[aria-invalid]))", count: 1, why: `an input group drops its shadow while its control is not at rest: ${OWN}` },
  { text: ":has( > button)", count: 2, why: `an input group's addon pulls in toward a button it holds: ${OWN}` },
  { text: ":has( > kbd:last-child)", count: 2, why: `an input group's addon pulls in toward a key it ends on: ${OWN}` },
  { text: ':has( > :last-child[data-slot="badge"])', count: 2, why: `an input group's addon pulls in toward a badge it ends on: ${OWN}` },
  { text: ':has( > [data-slot="composer-banner-actions"])', count: 1, why: `a banner row with no actions drops their column: ${OWN}` },
  { text: ":has( > :nth-child(2))", count: 5, why: `a banner row's actions, two or more, wrap under a narrow row: ${OWN}` },
  { text: ":has([data-popup-open])", count: 3, why: `a pull request event's actions stay out while their menu is open: ${OWN}` },
  { text: ":has([data-disabled])", count: 2, why: `the rewind dialog's option fades with its disabled radio: ${OWN}` },
  { text: ":has( > .w-full)", count: 1, why: `an autocomplete fits its field unless the field fills: ${OWN}` },
  { text: ':has( + [data-size="sm"])', count: 1, why: "an autocomplete's start addon steps in beside a small field: decides its own element alone, from its next sibling" },
  { text: ':has( + [data-slot="autocomplete-clear"])', count: 1, why: "an autocomplete's open button gives way to the clear button after it: decides its own element alone, from its next sibling" },
  { text: ':has( + [data-slot="command-footer"])', count: 1, why: "a command list rounds its foot when no footer follows it: decides its own element alone, from its next sibling" },
  { text: ':has( + [data-slot="toggle"][data-pressed])', count: 1, why: "a toggle group's separator lights beside a pressed toggle: decides its own element alone, from its next sibling" },
  { text: ':has( + [data-slot="toggle"]:hover)', count: 2, why: "a toggle group's separator lights beside a hovered toggle: decides its own element alone, from its next sibling" },
];

describe("the app's built CSS", () => {
  const css = builtCss();
  const lists = selectorLists(css);

  it("holds no :has() that styles past its own element or sits on the document's root", () => {
    expect(lists.length).toBeGreaterThan(1000);
    expect(lists.flatMap(broken)).toEqual([]);
  });

  it("holds each :has() left only as many times as its entry says, each with its reason", () => {
    const found = lists.flatMap(list => hasCalls(list).map(text => ({ text, where: list.slice(0, 80) })));
    expect(holdTo(found, SURVIVORS)).toEqual({ refused: [], over: [], stale: [] });
  });

  it("fails a class that asks a group what it holds, the shape Tailwind writes for group-has-*", () => {
    // Joined here, since Tailwind scans this file too and the whole class written out would land in every build.
    const withGroupHas = selectorLists(builtCss(["group-has-data-[x]", "g:p-1"].join("/")));
    expect(withGroupHas.flatMap(broken)).toEqual(["a :has() styling past its own element: :where(.group\\/g):has([data-x]) *"]);
  });

  it("reads the shapes it is meant to", () => {
    expect(broken(":is(:where(.group\\/g):has([data-x]) *)")).toHaveLength(1);
    expect(broken(".a:has(> b) > c")).toHaveLength(1);
    expect(broken(".a:has(b) + c")).toHaveLength(1);
    expect(broken("html.mac:has([x]) .y")).toHaveLength(1);
    expect(broken(":root:has(.a)")).toHaveLength(1);
    expect(broken(".a:has(:focus-visible)")).toEqual([]);
    expect(broken(".a:not(:has( > b))")).toEqual([]);
    expect(broken(".x .a[data-y]:has( + b):hover")).toEqual([]);
  });
});
