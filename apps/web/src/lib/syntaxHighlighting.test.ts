// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { getSyntaxHighlighterPromise, PREFERRED_HIGHLIGHTER } from "./syntaxHighlighting";

describe("syntaxHighlighting", () => {
  it("highlights typescript with the wasm engine and memoizes per language", async () => {
    expect(PREFERRED_HIGHLIGHTER).toBe("shiki-wasm");
    const first = getSyntaxHighlighterPromise("typescript");
    expect(getSyntaxHighlighterPromise("typescript")).toBe(first);
    const highlighter = await first;
    const html = highlighter.codeToHtml("const a: number = 1;", { lang: "typescript", theme: "pierre-dark" });
    expect(html).toContain('<pre class="shiki pierre-dark"');
    expect(html.match(/<span style="color:/g)?.length ?? 0).toBeGreaterThan(3);
  });

  it("falls back to plain text for a language shiki does not know", async () => {
    const highlighter = await getSyntaxHighlighterPromise("not-a-language");
    const html = highlighter.codeToHtml("hello", { lang: "text", theme: "pierre-light" });
    expect(html).toContain("hello");
  });
});
