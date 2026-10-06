// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { sourceStrings } from "./source-strings.js";

describe("the string literals the design law tests read", () => {
  it("an apostrophe in JSX text opens no string", () => {
    const text = `<p>Don't add it, it's done.</p>\n<span className="text-[13px]">x</span>`;
    expect(sourceStrings(text)).toEqual(["text-[13px]"]);
  });

  it("each quote closes on its own kind", () => {
    expect(sourceStrings(`const a = "it's"; const b = 'say "no"';`)).toEqual(["it's", 'say "no"']);
  });

  it("a template runs across lines with each expression cut out and its strings read", () => {
    const text = "const c = `flex\n  rounded-xl ${on ? \"bg-card\" : `text-[11px] ${n}`} border`;";
    expect(sourceStrings(text)).toEqual(["bg-card", "text-[11px]  ", "flex\n  rounded-xl   border"]);
  });

  it("skips comments, regular expressions and JSX tags", () => {
    const text = [
      "// a 'quoted' word in a comment",
      "/* and `one` here */",
      "const r = /[\"'`]x/g;",
      '<Row open={go} /><b>/</b><i className="ok">y</i>',
      "const d = a / b; const e = 'kept';",
    ].join("\n");
    expect(sourceStrings(text)).toEqual(["ok", "kept"]);
  });
});
