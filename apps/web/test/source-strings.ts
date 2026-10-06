// SPDX-License-Identifier: AGPL-3.0-only
// The string literals of a TypeScript source, as the design law tests read classes and colours out of it. A quote
// closes only on its own kind; a template runs across lines with each `${...}` cut out of its text and the strings
// inside it read in their own right; comments and regular expressions are skipped. A quote straight after a letter
// opens nothing, since in code a string never follows a letter and in JSX text it is an apostrophe (don't).

const WORD = /[\w$]/;
/** The last character before a slash that makes the slash open a regular expression rather than divide. A `<` or
 * a `}` is left out: there the slash is a JSX tag's (`</div>`, `<Row open={go} />`). */
const BEFORE_REGEX = /[(,=:[!&|?{;+\-*%>~^]/;

export function sourceStrings(text: string): string[] {
  const found: string[] = [];
  read(text, 0, false, found);
  return found;
}

/** Reads from `at` until the end, or until the `}` that closes a template's `${` when `inExpression`, collecting
 * every string; returns the index it stopped at. */
function read(text: string, at: number, inExpression: boolean, found: string[]): number {
  let depth = 0;
  let last = "";
  let i = at;
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      i = lineEnd(text, i);
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (c === "/" && next !== ">" && (last === "" || BEFORE_REGEX.test(last))) {
      i = regexEnd(text, i);
      last = "/";
      continue;
    }
    if ((c === '"' || c === "'") && !WORD.test(text[i - 1] ?? "")) {
      i = quoted(text, i, c, found);
      last = c;
      continue;
    }
    if (c === "`") {
      i = template(text, i, found);
      last = c;
      continue;
    }
    if (inExpression) {
      if (c === "{") depth++;
      if (c === "}") {
        if (depth === 0) return i;
        depth--;
      }
    }
    if (!/\s/.test(c)) last = c;
    i++;
  }
  return i;
}

const lineEnd = (text: string, at: number): number => {
  const end = text.indexOf("\n", at);
  return end < 0 ? text.length : end;
};

/** A string in single or double quotes, closed by its own kind on the same line. */
function quoted(text: string, at: number, quote: string, found: string[]): number {
  let i = at + 1;
  while (i < text.length && text[i] !== quote && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
  if (text[i] === quote) found.push(text.slice(at + 1, i));
  return i + 1;
}

/** A template across lines, its `${...}` read as code and left out of its text. */
function template(text: string, at: number, found: string[]): number {
  let words = "";
  let i = at + 1;
  while (i < text.length && text[i] !== "`") {
    if (text[i] === "\\") {
      words += text.slice(i, i + 2);
      i += 2;
    } else if (text[i] === "$" && text[i + 1] === "{") {
      i = read(text, i + 2, true, found) + 1;
      words += " ";
    } else words += text[i++];
  }
  found.push(words);
  return i + 1;
}

/** A regular expression's end, past its classes and escapes, on its own line. */
function regexEnd(text: string, at: number): number {
  let i = at + 1;
  let inClass = false;
  while (i < text.length && text[i] !== "\n") {
    const c = text[i]!;
    if (c === "\\") i++;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return i + 1;
    i++;
  }
  return i;
}
