// SPDX-License-Identifier: AGPL-3.0-only
// JSON with the comments Gemini CLI and OpenCode accept in their settings,
// and the trailing commas a hand-edited file tends to carry. One reader for
// everything that opens an agent's config, to list its servers or place one.

/** `out` without a comma that only whitespace separates from its end. */
function withoutTrailingComma(out: string): string {
  let j = out.length;
  while (j > 0 && /\s/.test(out[j - 1]!)) j--;
  return out[j - 1] === "," ? out.slice(0, j - 1) + out.slice(j) : out;
}

export interface Jsonc {
  value: unknown;
  /** The text held a comment, which a rewrite as plain JSON loses. */
  comments: boolean;
}

/** The value the text holds and whether it carried comments; a real syntax error throws as JSON.parse does. */
export function readJsonc(text: string): Jsonc {
  let out = "";
  let i = 0;
  let inString = false;
  let comments = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < text.length) out += text[++i];
      else if (c === '"') inString = false;
      i++;
    } else if (c === '"') {
      inString = true;
      out += c;
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      comments = true;
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      comments = true;
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      if (c === "}" || c === "]") out = withoutTrailingComma(out);
      out += c;
      i++;
    }
  }
  return { value: JSON.parse(out), comments };
}

export const parseJsonc = (text: string): unknown => readJsonc(text).value;
