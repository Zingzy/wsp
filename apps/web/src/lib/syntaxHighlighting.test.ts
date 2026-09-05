// SPDX-License-Identifier: AGPL-3.0-only
import { parsePatchFiles, renderDiffWithHighlighter, renderFileWithHighlighter } from "@pierre/diffs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDiffThemeName } from "./diffRendering";
import { getSyntaxHighlighterPromise, PREFERRED_HIGHLIGHTER } from "./syntaxHighlighting";

describe("syntaxHighlighting", () => {
  it("highlights typescript with the wasm engine and memoizes per language", async () => {
    expect(PREFERRED_HIGHLIGHTER).toBe("shiki-wasm");
    const first = getSyntaxHighlighterPromise("typescript");
    expect(getSyntaxHighlighterPromise("typescript")).toBe(first);
    const highlighter = await first;
    // The grammar's regexes compile in the wasm engine on the first tokenize, and shiki's 500 ms per-line limit cuts a cold line short on a loaded machine.
    const html = highlighter.codeToHtml("const a: number = 1;", { lang: "typescript", theme: "pierre-dark", tokenizeTimeLimit: 0 });
    expect(html).toContain('<pre class="shiki pierre-dark"');
    expect(html.match(/<span style="color:/g)?.length ?? 0).toBeGreaterThan(3);
  });

  it("falls back to plain text for a language shiki does not know", async () => {
    const highlighter = await getSyntaxHighlighterPromise("not-a-language");
    const html = highlighter.codeToHtml("hello", { lang: "text", theme: "pierre-light" });
    expect(html).toContain("hello");
  });
});

describe("diff and file preview render paths under a slow tokenizer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // vscode-textmate reads Date.now to cut a line at shiki's 500 ms limit; a clock that jumps a second per read is a starved worker.
  function jumpClock() {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));
  }

  function distinctColours(line: unknown): number {
    return new Set(JSON.stringify(line).match(/"style":"color:#[0-9a-f]+/gi)).size;
  }

  it("colours a cold line fully on the file preview path", async () => {
    const highlighter = await getSyntaxHighlighterPromise("tsx");
    jumpClock();
    const { code } = renderFileWithHighlighter(
      { name: "Panel.tsx", contents: "const el = <Panel size={2} label=\"a\" />;\n" },
      highlighter,
      { theme: resolveDiffThemeName("dark"), tokenizeMaxLineLength: 1000, useTokenTransformer: true },
    );
    expect(JSON.stringify(code[0])).toContain("Panel");
    expect(distinctColours(code[0])).toBeGreaterThan(3);
  });

  it("colours a cold line fully on the diff path", async () => {
    const highlighter = await getSyntaxHighlighterPromise("javascript");
    const patch = [
      "diff --git a/a.js b/a.js",
      "--- a/a.js",
      "+++ b/a.js",
      "@@ -1,1 +1,1 @@",
      "-const a = 1;",
      "+const a = foo(2) + \"x\";",
      "",
    ].join("\n");
    const file = parsePatchFiles(patch)[0]?.files[0];
    if (!file) throw new Error("patch did not parse");
    jumpClock();
    const { code } = renderDiffWithHighlighter(file, highlighter, {
      theme: resolveDiffThemeName("dark"),
      tokenizeMaxLineLength: 1000,
      useTokenTransformer: true,
      lineDiffType: "word-alt",
      maxLineDiffLength: 1000,
    });
    expect(JSON.stringify(code.additionLines[0])).toContain("foo");
    expect(distinctColours(code.additionLines[0])).toBeGreaterThan(3);
    expect(distinctColours(code.deletionLines[0])).toBeGreaterThan(3);
  });
});
